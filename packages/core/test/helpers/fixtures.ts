// Loads hook fixtures from fixtures/hooks/{provisional,cloud,pc,pc2,pc-desktop}.
// PROVISIONAL fixtures are from the docs, not observed (see fixtures/hooks/README.md).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../../src/fingerprint.js';
import { normalize } from '../../src/normalize.js';
import type { OfficeEvent, Source } from '../../src/schema.js';

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'hooks');
export const FIXTURE_SETS = ['provisional', 'cloud', 'pc', 'pc2', 'pc-desktop'] as const;
export type FixtureSet = (typeof FIXTURE_SETS)[number];

export interface FixtureCapture {
  platform?: string;
  form?: 'exec' | 'shell';
  env?: Record<string, boolean>;
  remoteSessionIdShape?: string | null;
}

export interface HookFixture {
  set: FixtureSet;
  file: string;
  provisional: boolean;
  /** Real capture (`_observed` wrapper), not docs-based. */
  observed: boolean;
  payload: Record<string, unknown>;
  /** `_capture` block of an observed export (env var PRESENCE only, never values). */
  capture?: FixtureCapture;
  /** The stdin text the emitter would hash. */
  raw: string;
}

/**
 * Stand-in for CLAUDE_CODE_REMOTE_SESSION_ID in the cloud set. The S2 capture
 * recorded only that the variable was set and its shape (`cse_`), never the
 * value, so tests feed this fake id of the real shape (`cse_` + 24 base62, S1).
 */
export const CLOUD_REMOTE_SESSION_ID = 'cse_01AbCdEfGhIjKlMnOpQrStUv';

/** What emit passes to normalize for this set: the cloud set runs as cloud, the others as the PC. */
export function fixtureContext(set: FixtureSet): { source: Source; remoteSessionId?: string } {
  return set === 'cloud' ? { source: 'cloud', remoteSessionId: CLOUD_REMOTE_SESSION_ID } : { source: 'local' };
}

/** normalize() one fixture the way emit would (source and remote id from its set). `salt` changes only the id. */
export async function normalizeFixture(f: HookFixture, emittedAt: number, salt = ''): Promise<OfficeEvent | null> {
  const ctx = fixtureContext(f.set);
  const id = await fingerprint(ctx.source, `${f.raw}${salt}`);
  return normalize(f.payload, { id, emittedAt, ...ctx });
}

export function loadFixtures(): HookFixture[] {
  const out: HookFixture[] = [];
  for (const set of FIXTURE_SETS) {
    const dir = join(FIXTURE_ROOT, set);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
      const payload = doc.payload as Record<string, unknown>;
      out.push({
        set,
        file,
        provisional: typeof doc._provisional === 'string',
        observed: typeof doc._observed === 'string',
        payload,
        ...(typeof doc._capture === 'object' && doc._capture !== null ? { capture: doc._capture } : {}),
        raw: JSON.stringify(payload),
      });
    }
  }
  return out;
}

/**
 * Normalize one fixture set in file order into OfficeEvents, emittedAt = t0 + i * step.
 * Fixtures normalize() ignores are dropped. Provisional sets are docs-based, not observed.
 */
export async function fixtureTimeline(set: FixtureSet, t0: number, step: number): Promise<OfficeEvent[]> {
  const out: OfficeEvent[] = [];
  let i = 0;
  for (const f of loadFixtures().filter((x) => x.set === set)) {
    const e = await normalizeFixture(f, t0 + i * step);
    i += 1;
    if (e) out.push(e);
  }
  return out;
}

/** First occurrence of each event id. The exec and shell hook forms of one event are the same payload. */
export function dedupeById(events: readonly OfficeEvent[]): OfficeEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => !seen.has(e.id) && seen.add(e.id));
}

/** Observed set -> OfficeEvents in capture order, exec/shell duplicates removed. */
export async function observedTimeline(set: FixtureSet, t0: number, step: number): Promise<OfficeEvent[]> {
  return dedupeById(await fixtureTimeline(set, t0, step));
}
