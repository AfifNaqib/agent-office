// OfficeHub's logic, free of Workers APIs so it runs on node:sqlite in tests.
// The Durable Object (hub.ts) owns one HubCore and passes in its clock.
import { MAX_PAGE, OfficeEventSchema, clampEmittedAt, sessionKey, type OfficeEvent } from '@agent-office/core';
import type { Logger } from './log.js';
import { hit, type Bucket, type RateResult } from './ratelimit.js';
import { migrate, type SqlStore } from './sql.js';

/** Plan §7 / FR-018: rows older than 7 days (by received_at) are deleted. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** FR-018: the retention alarm runs daily. */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Rows deleted per statement, so one alarm run stays well inside the CPU limit. */
export const RETENTION_BATCH = 5_000;
/** Batches per alarm run; when more remain, the alarm comes back after RETENTION_RETRY_MS. */
export const RETENTION_MAX_BATCHES = 20;
export const RETENTION_RETRY_MS = 60_000;

export type IngestResult =
  | { status: 'stored'; seq: number }
  | { status: 'duplicate' }
  | { status: 'rate_limited'; retryAfterSec: number }
  | { status: 'invalid' };

export interface StoredEvent {
  readonly seq: number;
  readonly event: OfficeEvent;
}

/**
 * A history page loaded with `after` + `limit` stops early once its payloads would
 * pass this many UTF-8 bytes (hasMore = true), so one RPC answer and one HTTP
 * response stay small even when events are near the 64 KB cap. At least one event
 * is always sent.
 */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * UTF-8 byte length of a string without allocating (L-1: CJK text is 3 bytes per
 * UTF-16 unit). A lone surrogate counts 3, like TextEncoder's U+FFFD.
 */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

/** One page of events, same shape as the PC bridge's history API (plan §10). */
export interface EventsPage {
  readonly boot: string;
  readonly lastSeq: number;
  readonly events: StoredEvent[];
  readonly hasMore: boolean;
}

/** One lobby row, same fields as the PC bridge's SessionEntry. */
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

export interface SessionsPage {
  readonly boot: string;
  readonly lastSeq: number;
  readonly sessions: SessionEntry[];
}

export interface HubCoreOptions {
  /** Called after each newly stored event is committed (fan-out to UI sockets). */
  readonly onStored?: (stored: StoredEvent) => void;
  /** Makes the boot id the first time the hub starts. Default crypto.randomUUID. */
  readonly newBoot?: () => string;
}

export interface SessionRow {
  readonly session_key: string;
  readonly source: string;
  readonly session_id: string;
  readonly remote_session_id: string | null;
  readonly run_id: string | null;
  readonly repo: string | null;
  /** 'live' or 'ended'. "idle" is derived at read time (core sessionStatus). */
  readonly status: string;
  /** Earliest emittedAt (clamped to the relay clock like core bufferPush). */
  readonly started_at: number;
  /** Latest emittedAt (clamped). */
  readonly last_event_at: number;
  /** Latest session.end emittedAt; cleared by an event emitted after it. */
  readonly ended_at: number | null;
}

export interface RetentionResult {
  readonly events: number;
  readonly sessions: number;
  /** True when the batch cap was hit and old rows are left. */
  readonly more: boolean;
}

export class HubCore {
  /**
   * Like the bridge's `boot`: clients that see a new value drop their state and
   * reload from seq 0. The relay's seq lives in SQLite and never restarts, so the
   * boot id is made once and kept in hub_meta; it only changes if the storage is wiped.
   */
  readonly boot: string;
  private readonly onStored: ((stored: StoredEvent) => void) | undefined;

  constructor(
    private readonly sql: SqlStore,
    opts: HubCoreOptions = {},
  ) {
    migrate(sql);
    this.onStored = opts.onStored;
    const fresh = (opts.newBoot ?? (() => crypto.randomUUID()))();
    sql.exec("INSERT INTO hub_meta (key, value) VALUES ('boot', ?) ON CONFLICT (key) DO NOTHING", fresh);
    this.boot = sql.exec<{ value: string }>("SELECT value FROM hub_meta WHERE key = 'boot'")[0]?.value ?? fresh;
  }

  /** Counts one hit in a rate bucket without storing anything (L-2: invalid bridge frames). */
  chargeRate(bucket: Bucket, now: number): RateResult {
    return hit(this.sql, bucket, now);
  }

  /**
   * Stores one event that the Worker already validated and cleaned (receivedAt set).
   * Re-validated here because the DO trusts nobody's types. Dedupe by id (FR-005).
   */
  ingest(input: unknown, bucket: Bucket, now: number): IngestResult {
    const parsed = OfficeEventSchema.safeParse(input);
    if (!parsed.success || parsed.data.receivedAt === undefined) return { status: 'invalid' };
    const e = parsed.data;
    const receivedAt = parsed.data.receivedAt;
    const result = this.sql.transaction((): IngestResult => {
      const rate = hit(this.sql, bucket, now);
      if (!rate.ok) return { status: 'rate_limited', retryAfterSec: rate.retryAfterSec };
      if (this.sql.exec('SELECT 1 AS x FROM events WHERE id = ?', e.id).length > 0) return { status: 'duplicate' };
      const key = sessionKey(e);
      this.upsertSession(e, key);
      const row = this.sql.exec<{ seq: number }>(
        `INSERT INTO events (id, session_key, emitted_at, received_at, kind, agent_type, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING seq`,
        e.id,
        key,
        e.emittedAt,
        receivedAt,
        e.kind,
        e.actor.agentType,
        JSON.stringify(e),
      )[0];
      return row === undefined ? { status: 'duplicate' } : { status: 'stored', seq: row.seq };
    });
    // After the commit, so a rolled-back event is never pushed to a socket.
    if (result.status === 'stored') this.onStored?.({ seq: result.seq, event: e });
    return result;
  }

  /**
   * Session row, same rules as core `reduceSessions` so the relay and the clients
   * agree whatever order events arrive in (M-1): times come from emittedAt (clamped
   * like core `bufferPush` does, so a forged clock cannot pin a row), started_at is
   * the earliest, last_event_at the latest, a session.end sets ended_at, and only an
   * event emitted AFTER ended_at revives the session.
   */
  private upsertSession(input: OfficeEvent, key: string): void {
    const e = clampEmittedAt(input, input.receivedAt ?? 0);
    const at = e.emittedAt;
    const cur = this.sql.exec<{ started_at: number; last_event_at: number; ended_at: number | null }>(
      'SELECT started_at, last_event_at, ended_at FROM sessions WHERE session_key = ?',
      key,
    )[0];
    let endedAt = cur?.ended_at ?? null;
    if (e.kind === 'session.end') endedAt = Math.max(endedAt ?? at, at);
    else if (endedAt !== null && at > endedAt) endedAt = null; // resumed after its end
    const startedAt = Math.min(cur?.started_at ?? at, at);
    const lastEventAt = Math.max(cur?.last_event_at ?? at, at);
    const status = endedAt === null ? 'live' : 'ended';
    this.sql.exec(
      `INSERT INTO sessions (session_key, source, session_id, remote_session_id, run_id, repo, status, started_at, last_event_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_key) DO UPDATE SET
         remote_session_id = COALESCE(remote_session_id, excluded.remote_session_id),
         run_id = COALESCE(run_id, excluded.run_id),
         repo = COALESCE(repo, excluded.repo),
         status = excluded.status,
         started_at = excluded.started_at,
         last_event_at = excluded.last_event_at,
         ended_at = excluded.ended_at`,
      key,
      e.source,
      e.sessionId,
      e.remoteSessionId ?? null,
      e.runId ?? null,
      e.repo ?? null,
      status,
      startedAt,
      lastEventAt,
      endedAt,
    );
  }

  /** Events with seq > after in arrival order, at most `limit` (1..MAX_PAGE). */
  eventsAfter(after: number, limit: number): StoredEvent[] {
    return this.page(after, limit, undefined).events;
  }

  /**
   * Highest seq ever given out (the bridge's lastSeq), 0 before the first event.
   * Read from sqlite_sequence (AUTOINCREMENT keeps it), so it never drops back
   * when retention empties the table (L-3); MAX(seq) is the fallback.
   */
  lastSeq(): number {
    let fromSequence = 0;
    try {
      fromSequence = this.sql.exec<{ s: number | null }>("SELECT seq AS s FROM sqlite_sequence WHERE name = 'events'")[0]?.s ?? 0;
    } catch {
      // sqlite_sequence not readable: fall back to the table.
    }
    const fromTable = this.sql.exec<{ s: number | null }>('SELECT MAX(seq) AS s FROM events')[0]?.s ?? 0;
    return Math.max(fromSequence, fromTable);
  }

  /** GET /api/events: every session, seq > after, oldest first. */
  events(after: number, limit: number): EventsPage {
    return { boot: this.boot, lastSeq: this.lastSeq(), ...this.page(after, limit, undefined) };
  }

  /** GET /api/sessions/:key/events. Null for an unknown session (404). */
  sessionEvents(key: string, after: number, limit: number): EventsPage | null {
    if (this.sql.exec('SELECT 1 AS x FROM sessions WHERE session_key = ?', key).length === 0) return null;
    return { boot: this.boot, lastSeq: this.lastSeq(), ...this.page(after, limit, key) };
  }

  /** GET /api/sessions: newest activity first, like the bridge. */
  sessionList(): SessionsPage {
    const rows = this.sql.exec<{
      session_key: string;
      source: string;
      session_id: string;
      remote_session_id: string | null;
      run_id: string | null;
      repo: string | null;
      started_at: number;
      last_event_at: number;
      ended_at: number | null;
      event_count: number;
      last_seq: number | null;
    }>(
      `SELECT s.session_key, s.source, s.session_id, s.remote_session_id, s.run_id, s.repo,
              s.started_at, s.last_event_at, s.ended_at,
              COUNT(e.seq) AS event_count, MAX(e.seq) AS last_seq
       FROM sessions s LEFT JOIN events e ON e.session_key = s.session_key
       GROUP BY s.session_key
       ORDER BY s.last_event_at DESC, s.session_key`,
    );
    const sessions = rows.map(
      (r): SessionEntry => ({
        key: r.session_key,
        source: r.source === 'local' ? 'local' : 'cloud',
        sessionId: r.session_id,
        remoteSessionId: r.remote_session_id,
        runId: r.run_id,
        repo: r.repo,
        startedAt: r.started_at,
        lastEventAt: r.last_event_at,
        endedAt: r.ended_at,
        eventCount: r.event_count,
        lastSeq: r.last_seq ?? 0,
      }),
    );
    return { boot: this.boot, lastSeq: this.lastSeq(), sessions };
  }

  /** Events received in the last 7 days (GET /api/health `events7d`). */
  events7d(now: number): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE received_at >= ?', now - RETENTION_MS)[0]?.n ?? 0;
  }

  /**
   * One page: up to `limit` rows (clamped to 1..MAX_PAGE) and MAX_PAGE_BYTES of
   * payload. One extra row is read to tell whether more follow.
   */
  private page(after: number, limit: number, key: string | undefined): { events: StoredEvent[]; hasMore: boolean } {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), MAX_PAGE)) : 1;
    const rows =
      key === undefined
        ? this.sql.exec<{ seq: number; payload_json: string }>(
            'SELECT seq, payload_json FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
            after,
            n + 1,
          )
        : this.sql.exec<{ seq: number; payload_json: string }>(
            'SELECT seq, payload_json FROM events WHERE session_key = ? AND seq > ? ORDER BY seq LIMIT ?',
            key,
            after,
            n + 1,
          );
    const events: StoredEvent[] = [];
    let bytes = 0;
    for (const r of rows.slice(0, n)) {
      const size = utf8Length(r.payload_json);
      if (events.length > 0 && bytes + size > MAX_PAGE_BYTES) return { events, hasMore: true };
      bytes += size;
      events.push({ seq: r.seq, event: JSON.parse(r.payload_json) as OfficeEvent });
    }
    return { events, hasMore: rows.length > n };
  }

  sessions(): SessionRow[] {
    return this.sql.exec<SessionRow & Record<string, string | number | null>>(
      'SELECT * FROM sessions ORDER BY last_event_at DESC, session_key',
    );
  }

  /**
   * FR-018: deletes events received more than 7 days before `now`, then sessions
   * with no events left. Batched; `more` tells the caller to come back soon.
   */
  retention(now: number): RetentionResult {
    const cutoff = now - RETENTION_MS;
    let events = 0;
    let more = false;
    for (let i = 0; i < RETENTION_MAX_BATCHES; i += 1) {
      const n = this.sql.exec(
        'DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE received_at < ? ORDER BY seq LIMIT ?) RETURNING seq',
        cutoff,
        RETENTION_BATCH,
      ).length;
      events += n;
      if (n < RETENTION_BATCH) break;
      if (i === RETENTION_MAX_BATCHES - 1) more = true;
    }
    const sessions = this.sql.exec(
      'DELETE FROM sessions WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.session_key = sessions.session_key) RETURNING session_key',
    ).length;
    return { events, sessions, more };
  }
}

/** The two alarm calls of DurableObjectStorage the hub uses (fake in tests). */
export interface AlarmApi {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/** On DO start: schedule the daily retention alarm unless one is already set. */
export async function ensureRetentionAlarm(api: AlarmApi, now: number): Promise<void> {
  if ((await api.getAlarm()) === null) await api.setAlarm(now + RETENTION_INTERVAL_MS);
}

/**
 * The alarm handler: one retention pass, one log line, then the next alarm, in
 * RETENTION_RETRY_MS when rows are left, else in RETENTION_INTERVAL_MS (FR-018).
 */
export async function runRetentionAlarm(core: HubCore, api: AlarmApi, now: number, log: Logger): Promise<RetentionResult> {
  const r = core.retention(now);
  log({ route: 'retention', status: `events=${r.events} sessions=${r.sessions}${r.more ? ' more' : ''}` });
  await api.setAlarm(now + (r.more ? RETENTION_RETRY_MS : RETENTION_INTERVAL_MS));
  return r;
}
