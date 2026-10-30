// Bridge storage (plan §7, v0): an in-memory index plus append-only daily JSONL
// files (`YYYY-MM-DD.jsonl`, UTC day of receivedAt). Only normalized, redacted
// events are ever written. Dedupe is by event id only (FR-005, A2.3): the id set
// is the "unique index". Files whose whole day is older than the retention are
// deleted at startup and on a timer; the memory index drops the same events.
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { MAX_EVENT_BYTES, OfficeEventSchema, type OfficeEvent } from '@agent-office/core';
import type { Logger } from './log.js';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface StoredEvent {
  /** Arrival order in this bridge process (and its reloaded history). Not stable across restarts: clients compare `boot`. */
  readonly seq: number;
  readonly event: OfficeEvent;
}

export interface SessionEntry {
  readonly key: string;
  readonly source: OfficeEvent['source'];
  readonly sessionId: string;
  readonly remoteSessionId: string | null;
  readonly runId: string | null;
  readonly repo: string | null;
  readonly startedAt: number;
  readonly lastEventAt: number;
  readonly endedAt: number | null;
  readonly eventCount: number;
  readonly lastSeq: number;
}

export interface StoreOptions {
  readonly dir: string;
  readonly now: () => number;
  readonly logger: Logger;
  readonly retentionMs?: number;
}

export type AddResult = { readonly status: 'stored'; readonly stored: StoredEvent } | { readonly status: 'duplicate' };

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayEnd(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
}

function sessionKeyOf(e: OfficeEvent): string {
  return `${e.source}:${e.sessionId}`;
}

function bumpSession(prev: SessionEntry | undefined, s: StoredEvent): SessionEntry {
  const e = s.event;
  const base: SessionEntry = prev ?? {
    key: sessionKeyOf(e),
    source: e.source,
    sessionId: e.sessionId,
    remoteSessionId: null,
    runId: null,
    repo: null,
    startedAt: e.emittedAt,
    lastEventAt: e.emittedAt,
    endedAt: null,
    eventCount: 0,
    lastSeq: 0,
  };
  return {
    ...base,
    remoteSessionId: base.remoteSessionId ?? e.remoteSessionId ?? null,
    runId: base.runId ?? e.runId ?? null,
    repo: base.repo ?? e.repo ?? null,
    startedAt: Math.min(base.startedAt, e.emittedAt),
    lastEventAt: Math.max(base.lastEventAt, e.emittedAt),
    endedAt: e.kind === 'session.end' ? Math.max(base.endedAt ?? 0, e.emittedAt) : base.endedAt,
    eventCount: base.eventCount + 1,
    lastSeq: s.seq,
  };
}

export class EventStore {
  private records: StoredEvent[] = [];
  private bySession = new Map<string, StoredEvent[]>();
  private summaries = new Map<string, SessionEntry>();
  private readonly ids = new Set<string>();
  /** Ids accepted but not yet written: a concurrent duplicate must not slip through the write gap. */
  private readonly pending = new Set<string>();
  /** Files whose last line has no newline (crash mid-write): the next append starts a new line. */
  private readonly dirtyTail = new Set<string>();
  private nextSeq = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly retentionMs: number;

  private constructor(private readonly opts: StoreOptions) {
    this.retentionMs = opts.retentionMs ?? RETENTION_MS;
  }

  /** Creates the folder, deletes expired files, loads the rest. */
  static async open(opts: StoreOptions): Promise<EventStore> {
    const store = new EventStore(opts);
    await mkdir(opts.dir, { recursive: true, mode: 0o700 });
    await store.cleanup();
    await store.load();
    return store;
  }

  get size(): number {
    return this.records.length;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  has(id: string): boolean {
    return this.ids.has(id) || this.pending.has(id);
  }

  private cutoff(): number {
    return this.opts.now() - this.retentionMs;
  }

  private async load(): Promise<void> {
    const cutoff = this.cutoff();
    const names = (await readdir(this.opts.dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && FILE_RE.test(d.name))
      .map((d) => d.name)
      .sort();
    let skipped = 0;
    for (const name of names) {
      const path = join(this.opts.dir, name);
      const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (line === '') continue;
        const event = line.length <= MAX_EVENT_BYTES ? parseLine(line) : undefined;
        if (!event || event.receivedAt === undefined) {
          skipped += 1;
          continue;
        }
        if (event.receivedAt < cutoff || this.ids.has(event.id)) continue;
        this.commit(event);
      }
      if (await endsWithoutNewline(path)) this.dirtyTail.add(name);
    }
    this.opts.logger.info(`loaded ${this.records.length} events from ${names.length} files, ${skipped} unreadable lines skipped`);
  }

  private commit(event: OfficeEvent): StoredEvent {
    const stored: StoredEvent = { seq: this.nextSeq, event };
    this.nextSeq += 1;
    this.records.push(stored);
    this.ids.add(event.id);
    const key = sessionKeyOf(event);
    const list = this.bySession.get(key);
    if (list) list.push(stored);
    else this.bySession.set(key, [stored]);
    this.summaries.set(key, bumpSession(this.summaries.get(key), stored));
    return stored;
  }

  /**
   * Store `event` (must carry the bridge's receivedAt). A known id is a no-op
   * ('duplicate'). Resolves after the line is on disk; rejects when the write fails
   * (nothing is kept in memory in that case).
   */
  async add(event: OfficeEvent): Promise<AddResult> {
    if (this.has(event.id)) return { status: 'duplicate' };
    this.pending.add(event.id);
    try {
      await this.append(event);
    } finally {
      this.pending.delete(event.id);
    }
    return { status: 'stored', stored: this.commit(event) };
  }

  private append(event: OfficeEvent): Promise<void> {
    const name = `${dayOf(event.receivedAt ?? this.opts.now())}.jsonl`;
    const run = async (): Promise<void> => {
      const lead = this.dirtyTail.has(name) ? '\n' : '';
      await appendFile(join(this.opts.dir, name), `${lead}${JSON.stringify(event)}\n`, { mode: 0o600 });
      this.dirtyTail.delete(name);
    };
    const next = this.chain.then(run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Wait until every accepted write has finished. */
  async flush(): Promise<void> {
    await this.chain;
  }

  /** Delete files whose whole day is older than the retention, and drop the events they held from memory. Returns the files deleted. */
  async cleanup(): Promise<number> {
    const cutoff = this.cutoff();
    let deleted = 0;
    for (const d of await readdir(this.opts.dir, { withFileTypes: true })) {
      const m = FILE_RE.exec(d.name);
      if (!d.isFile() || !m?.[1] || dayEnd(m[1]) > cutoff) continue;
      try {
        await unlink(join(this.opts.dir, d.name));
        this.dirtyTail.delete(d.name);
        deleted += 1;
      } catch {
        this.opts.logger.warn('could not delete an expired event file');
      }
    }
    this.evict(cutoff);
    return deleted;
  }

  private evict(cutoff: number): void {
    if (!this.records.some((r) => (r.event.receivedAt ?? 0) < cutoff)) return;
    const kept = this.records.filter((r) => (r.event.receivedAt ?? 0) >= cutoff);
    this.records = kept;
    this.ids.clear();
    this.bySession = new Map();
    this.summaries = new Map();
    for (const r of kept) {
      this.ids.add(r.event.id);
      const key = sessionKeyOf(r.event);
      const list = this.bySession.get(key);
      if (list) list.push(r);
      else this.bySession.set(key, [r]);
      this.summaries.set(key, bumpSession(this.summaries.get(key), r));
    }
  }

  sessions(): SessionEntry[] {
    return [...this.summaries.values()].sort((a, b) => b.lastEventAt - a.lastEventAt || (a.key < b.key ? -1 : 1));
  }

  hasSession(key: string): boolean {
    return this.bySession.has(key);
  }

  /** Events of one session with seq > after, oldest first. */
  sessionEvents(key: string, after: number, limit: number): { events: StoredEvent[]; hasMore: boolean } {
    return page(this.bySession.get(key) ?? [], after, limit);
  }

  /** Events of all sessions with seq > after (catch-up after a dropped socket). */
  allEvents(after: number, limit: number): { events: StoredEvent[]; hasMore: boolean } {
    return page(this.records, after, limit);
  }
}

function page(list: readonly StoredEvent[], after: number, limit: number): { events: StoredEvent[]; hasMore: boolean } {
  // list is sorted by seq: binary search for the first seq > after.
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((list[mid]?.seq ?? 0) > after) hi = mid;
    else lo = mid + 1;
  }
  const events = list.slice(lo, lo + limit);
  return { events, hasMore: lo + limit < list.length };
}

function parseLine(line: string): OfficeEvent | undefined {
  try {
    const r = OfficeEventSchema.safeParse(JSON.parse(line));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

async function endsWithoutNewline(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    await fh.close();
  }
}
