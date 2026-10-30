// HubCore (OfficeHub's logic) on node:sqlite: schema migration, retention alarm
// work, session rows, input re-validation, rate-limit windows.
import { DatabaseSync } from 'node:sqlite';
import { MAX_FUTURE_SKEW_MS, initialSessionsState, reduceSessions, type OfficeEvent } from '@agent-office/core';
import { describe, expect, it } from 'vitest';
import {
  HubCore,
  RETENTION_BATCH,
  RETENTION_INTERVAL_MS,
  RETENTION_MAX_BATCHES,
  RETENTION_MS,
  RETENTION_RETRY_MS,
  ensureRetentionAlarm,
  runRetentionAlarm,
  type AlarmApi,
} from '../src/hubCore.js';
import type { LogFields } from '../src/log.js';
import { LIMITS, WINDOW_MS } from '../src/ratelimit.js';
import { MIGRATIONS, migrate } from '../src/sql.js';
import { NOW0, makeEvent, sqliteStore } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

function fresh(): { core: HubCore; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  return { core: new HubCore(sqliteStore(db)), db };
}

function put(core: HubCore, n: number, receivedAt: number, over: Parameters<typeof makeEvent>[1] = {}): void {
  const r = core.ingest({ ...makeEvent(n, over), receivedAt }, 'ingest', receivedAt);
  expect(r.status).toBe('stored');
}

describe('schema migration', () => {
  it('creates the V1 tables once; running it again is a no-op', () => {
    const db = new DatabaseSync(':memory:');
    const sql = sqliteStore(db);
    expect(migrate(sql)).toBe(MIGRATIONS.length);
    expect(migrate(sql)).toBe(MIGRATIONS.length);
    new HubCore(sql);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['events', 'rate_limits', 'schema_meta', 'sessions']));
  });

  it('a failed step rolls back and leaves the version unchanged', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE sessions (x INTEGER)'); // makes step 0 fail
    expect(() => migrate(sqliteStore(db))).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_meta'").get()).toBeUndefined();
  });
});

describe('AC: the retention alarm deletes rows older than 7 days', () => {
  it('deletes old events and sessions left empty; keeps newer rows', () => {
    const { core } = fresh();
    const now = NOW0 + 10 * DAY;
    put(core, 1, now - RETENTION_MS - 1, { sessionId: 'old-session' });
    put(core, 2, now - RETENTION_MS - 1, { sessionId: 'mixed' });
    put(core, 3, now - RETENTION_MS + 1, { sessionId: 'mixed' });
    put(core, 4, now - 1000, { sessionId: 'new' });
    expect(core.retention(now)).toEqual({ events: 2, sessions: 1, more: false });
    expect(core.eventsAfter(0, 100).map((s) => s.event.id)).toEqual([makeEvent(3).id, makeEvent(4).id]);
    expect(core.sessions().map((s) => s.session_id).sort()).toEqual(['mixed', 'new']);
    expect(core.retention(now)).toEqual({ events: 0, sessions: 0, more: false });
  });

  it('works in batches and reports when more is left', () => {
    const { core, db } = fresh();
    const total = RETENTION_BATCH * RETENTION_MAX_BATCHES + 10;
    db.exec('BEGIN');
    db.prepare("INSERT INTO sessions VALUES ('cloud:s', 'cloud', 's', NULL, NULL, NULL, 'live', 0, 0, NULL)").run();
    const ins = db.prepare("INSERT INTO events (id, session_key, emitted_at, received_at, kind, agent_type, payload_json) VALUES (?, 'cloud:s', 0, 0, 'tool.start', NULL, '{}')");
    for (let i = 0; i < total; i++) ins.run(`id-${i}`);
    db.exec('COMMIT');
    expect(core.retention(NOW0)).toEqual({ events: RETENTION_BATCH * RETENTION_MAX_BATCHES, sessions: 0, more: true });
    expect(core.retention(NOW0)).toEqual({ events: 10, sessions: 1, more: false });
  });
});

// L-2: the alarm handler itself (hub.ts only forwards ctx.storage and Date.now()).
describe('retention alarm handler', () => {
  function fakeAlarm(initial: number | null = null): AlarmApi & { at: number | null; sets: number[] } {
    const api = {
      at: initial,
      sets: [] as number[],
      getAlarm: () => Promise.resolve(api.at),
      setAlarm: (t: number) => {
        api.at = t;
        api.sets.push(t);
        return Promise.resolve();
      },
    };
    return api;
  }

  it('on start schedules the first alarm in 24 h, and keeps an existing one', async () => {
    const api = fakeAlarm();
    await ensureRetentionAlarm(api, NOW0);
    expect(api.at).toBe(NOW0 + RETENTION_INTERVAL_MS);
    await ensureRetentionAlarm(api, NOW0 + 5000);
    expect(api.sets).toEqual([NOW0 + RETENTION_INTERVAL_MS]);
  });

  it('runs retention, logs counts only, and reschedules to +24 h when done', async () => {
    const { core } = fresh();
    const now = NOW0 + 10 * DAY;
    put(core, 1, now - RETENTION_MS - 1, { sessionId: 'old' });
    put(core, 2, now - 1000, { sessionId: 'new' });
    const api = fakeAlarm(now);
    const logs: LogFields[] = [];
    expect(await runRetentionAlarm(core, api, now, (f) => logs.push(f))).toEqual({ events: 1, sessions: 1, more: false });
    expect(api.at).toBe(now + RETENTION_INTERVAL_MS);
    expect(logs).toEqual([{ route: 'retention', status: 'events=1 sessions=1' }]);
  });

  it('comes back after 60 s while old rows are left ("more" path), then returns to +24 h', async () => {
    const { core, db } = fresh();
    const total = RETENTION_BATCH * RETENTION_MAX_BATCHES + 1;
    db.exec('BEGIN');
    db.prepare("INSERT INTO sessions VALUES ('cloud:s', 'cloud', 's', NULL, NULL, NULL, 'live', 0, 0, NULL)").run();
    const ins = db.prepare("INSERT INTO events (id, session_key, emitted_at, received_at, kind, agent_type, payload_json) VALUES (?, 'cloud:s', 0, 0, 'tool.start', NULL, '{}')");
    for (let i = 0; i < total; i++) ins.run(`id-${i}`);
    db.exec('COMMIT');
    const api = fakeAlarm(NOW0);
    const logs: LogFields[] = [];
    const first = await runRetentionAlarm(core, api, NOW0, (f) => logs.push(f));
    expect(first.more).toBe(true);
    expect(api.at).toBe(NOW0 + RETENTION_RETRY_MS);
    expect(logs[0]?.status).toMatch(/ more$/);
    const later = NOW0 + RETENTION_RETRY_MS;
    expect(await runRetentionAlarm(core, api, later, () => undefined)).toEqual({ events: 1, sessions: 1, more: false });
    expect(api.at).toBe(later + RETENTION_INTERVAL_MS);
  });
});

describe('ingest (DO side)', () => {
  it('re-validates input: missing receivedAt, wrong shape or extra fields -> invalid, nothing stored', () => {
    const { core } = fresh();
    expect(core.ingest(makeEvent(1), 'ingest', NOW0)).toEqual({ status: 'invalid' });
    expect(core.ingest({ ...makeEvent(1), receivedAt: NOW0, extra: 1 }, 'ingest', NOW0)).toEqual({ status: 'invalid' });
    expect(core.ingest('x', 'ingest', NOW0)).toEqual({ status: 'invalid' });
    expect(core.eventsAfter(0, 10)).toEqual([]);
  });

  it('dedupes by id and gives increasing seq numbers', () => {
    const { core } = fresh();
    const a = core.ingest({ ...makeEvent(1), receivedAt: NOW0 }, 'ingest', NOW0);
    const b = core.ingest({ ...makeEvent(2), receivedAt: NOW0 }, 'ingest', NOW0);
    expect(core.ingest({ ...makeEvent(1), receivedAt: NOW0 + 5 }, 'ingest', NOW0)).toEqual({ status: 'duplicate' });
    expect(a).toEqual({ status: 'stored', seq: 1 });
    expect(b).toEqual({ status: 'stored', seq: 2 });
    expect(core.eventsAfter(1, 10).map((s) => s.seq)).toEqual([2]);
  });

  it('session rows: first values kept, last_event_at grows, session.end ends it, a later event revives it', () => {
    const { core } = fresh();
    put(core, 1, NOW0, { repo: undefined, remoteSessionId: undefined, emittedAt: NOW0 });
    put(core, 2, NOW0 + 5000, { repo: 'portfolio', emittedAt: NOW0 + 50 });
    put(core, 3, NOW0 + 5000, { kind: 'session.end', tool: undefined, repo: 'other', emittedAt: NOW0 + 100 });
    expect(core.sessions()[0]).toMatchObject({
      repo: 'portfolio',
      remote_session_id: 'cse_01AbCdEfGhIjKlMnOpQrStUv',
      status: 'ended',
      started_at: NOW0,
      last_event_at: NOW0 + 100,
      ended_at: NOW0 + 100,
    });
    put(core, 4, NOW0 + 6000, { emittedAt: NOW0 + 200 });
    expect(core.sessions()[0]).toMatchObject({ status: 'live', ended_at: null, last_event_at: NOW0 + 200 });
  });

  // M-1: the row follows core reduceSessions whatever the arrival order.
  describe('M-1: session row by emittedAt, not arrival order', () => {
    const T = NOW0 + 10_000;
    const end = { kind: 'session.end' as const, tool: undefined, emittedAt: T };

    it('an event emitted before the session.end but arriving after it keeps the session ended', () => {
      const { core } = fresh();
      put(core, 1, T, end);
      put(core, 2, T + 100, { kind: 'tool.end', emittedAt: T - 500 });
      expect(core.sessions()[0]).toMatchObject({ status: 'ended', ended_at: T, started_at: T - 500, last_event_at: T });
    });

    it('an event emitted after the session.end revives it', () => {
      const { core } = fresh();
      put(core, 1, T, end);
      put(core, 2, T + 600, { kind: 'tool.end', emittedAt: T + 500 });
      expect(core.sessions()[0]).toMatchObject({ status: 'live', ended_at: null, last_event_at: T + 500 });
    });

    it('an event at exactly the end time does not revive; a late older session.end does not move ended_at back', () => {
      const { core } = fresh();
      put(core, 1, T, end);
      put(core, 2, T, { emittedAt: T });
      put(core, 3, T + 10, { ...end, emittedAt: T - 1000 });
      expect(core.sessions()[0]).toMatchObject({ status: 'ended', ended_at: T });
    });

    it('started_at is the earliest emittedAt, not the first arrival', () => {
      const { core } = fresh();
      put(core, 1, T, { emittedAt: T });
      put(core, 2, T + 100, { emittedAt: T - 3000 });
      expect(core.sessions()[0]).toMatchObject({ started_at: T - 3000, last_event_at: T });
    });

    it('matches core reduceSessions for every arrival order of a small run', () => {
      const evs: OfficeEvent[] = [
        makeEvent(1, { kind: 'session.start', tool: undefined, emittedAt: T - 2000 }),
        makeEvent(2, { emittedAt: T - 1000 }),
        makeEvent(3, { ...end }),
        makeEvent(4, { kind: 'tool.end', emittedAt: T - 500 }),
        makeEvent(5, { emittedAt: T + 500 }),
      ];
      const perms = (xs: OfficeEvent[]): OfficeEvent[][] =>
        xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
      for (const order of perms(evs)) {
        for (const cut of [3, 4, 5]) {
          const { core } = fresh();
          let state = initialSessionsState();
          for (const e of order.slice(0, cut)) {
            expect(core.ingest({ ...e, receivedAt: T + 1000 }, 'ingest', T + 1000).status).toBe('stored');
            state = reduceSessions(state, e);
          }
          const s = Object.values(state.sessions)[0];
          expect(core.sessions()[0]).toMatchObject({
            status: s?.endedAt === null ? 'live' : 'ended',
            ended_at: s?.endedAt,
            started_at: s?.startedAt,
            last_event_at: s?.lastEventAt,
          });
        }
      }
    });

    it('a forged far-future emittedAt is clamped to receivedAt + 60 s for the row (core bufferPush rule)', () => {
      const { core } = fresh();
      put(core, 1, T, { kind: 'session.end', tool: undefined, emittedAt: T + 365 * DAY });
      expect(core.sessions()[0]).toMatchObject({ ended_at: T + MAX_FUTURE_SKEW_MS, last_event_at: T + MAX_FUTURE_SKEW_MS });
      put(core, 2, T + 2 * MAX_FUTURE_SKEW_MS, { emittedAt: T + 2 * MAX_FUTURE_SKEW_MS });
      expect(core.sessions()[0]).toMatchObject({ status: 'live', ended_at: null });
    });
  });

  it('rate-limit windows reset each minute; refused hits store nothing', () => {
    const { core } = fresh();
    const t = NOW0 - (NOW0 % WINDOW_MS);
    for (let i = 0; i < LIMITS.ingest; i++) put(core, i, t + 59_000);
    expect(core.ingest({ ...makeEvent(9999), receivedAt: t }, 'ingest', t + 59_000)).toEqual({ status: 'rate_limited', retryAfterSec: 1 });
    expect(core.ingest({ ...makeEvent(9999), receivedAt: t }, 'ingest', t + WINDOW_MS).status).toBe('stored');
    expect(core.eventsAfter(0, 5000)).toHaveLength(LIMITS.ingest + 1);
  });

  it('eventsAfter clamps the page size', () => {
    const { core } = fresh();
    put(core, 1, NOW0);
    put(core, 2, NOW0);
    expect(core.eventsAfter(0, 0)).toHaveLength(1);
    expect(core.eventsAfter(0, -5)).toHaveLength(1);
  });
});
