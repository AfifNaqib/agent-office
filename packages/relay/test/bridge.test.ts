// V1-04 relay side under plain Node: the /bridge route (token, upgrade, Origin), the
// bridge message handler on HubCore (same validation/cleaning as /ingest, source
// forced to 'local', relay clock, dedupe, rate limit 1200/min, size caps), bridge
// liveness helpers, the shared alarm (retention + bridge check) and health.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { RETENTION_AT_KEY, runHubAlarm, scheduleHubAlarm, wantedAlarm, type AlarmStorage } from '../src/alarms.js';
import {
  BRIDGE_CHECK_MS,
  BRIDGE_STALE_MS,
  CLOSE_POLICY,
  CLOSE_TOO_BIG,
  CLOSE_UNSUPPORTED,
  MAX_BRIDGE_MESSAGE_BYTES,
  bridgeFresh,
  bridgeLastSeen,
  bridgeStatusMessage,
  bridgeUpgradeRequest,
  handleBridgeMessage,
  RejectLogThrottle,
} from '../src/bridgeSockets.js';
import { HubCore, RETENTION_INTERVAL_MS, RETENTION_MS, type StoredEvent } from '../src/hubCore.js';
import type { LogFields } from '../src/log.js';
import { LIMITS } from '../src/ratelimit.js';
import { ACCESS_ENV, BASE, BRIDGE_TOKEN, NOW0, TOKEN, WRONG, makeEvent, sqliteStore, startRig } from './helpers.js';

const UPGRADE = { upgrade: 'websocket', connection: 'Upgrade' };

function hub(): { core: HubCore; pushed: StoredEvent[] } {
  const pushed: StoredEvent[] = [];
  const core = new HubCore(sqliteStore(new DatabaseSync(':memory:')), { onStored: (s) => pushed.push(s) });
  return { core, pushed };
}

function send(core: HubCore, message: string | ArrayBuffer, now = NOW0): ReturnType<typeof handleBridgeMessage> {
  return handleBridgeMessage(message, (e) => core.ingest(e, 'bridge', now), now, () => core.chargeRate('bridge', now));
}

const msg = (event: unknown): string => JSON.stringify({ type: 'event', event });
const parsed = (out: ReturnType<typeof handleBridgeMessage>): unknown => JSON.parse(out.reply ?? 'null');

describe('GET /bridge route', () => {
  it('503 when BRIDGE_TOKEN is missing or too short (fails closed)', async () => {
    for (const env of [{ INGEST_TOKEN: TOKEN, ...ACCESS_ENV }, { INGEST_TOKEN: TOKEN, BRIDGE_TOKEN: 'short', ...ACCESS_ENV }]) {
      const r = startRig(env);
      const res = await r.fetch('/bridge', { headers: { ...UPGRADE, authorization: `Bearer ${BRIDGE_TOKEN}` } });
      expect(res.status).toBe(503);
      expect(r.bridgeUpgrades).toHaveLength(0);
    }
  });

  it.each([
    ['no Authorization', null],
    ['wrong token', `Bearer ${WRONG}`],
    ['the INGEST token', `Bearer ${TOKEN}`],
    ['Basic scheme', `Basic ${BRIDGE_TOKEN}`],
    ['token with a suffix', `Bearer ${BRIDGE_TOKEN}x`],
  ])('401 with %s, nothing reaches the DO, the log has no token', async (_n, auth) => {
    const r = startRig();
    const headers: Record<string, string> = { ...UPGRADE };
    if (auth !== null) headers.authorization = auth;
    const res = await r.fetch('/bridge', { headers });
    expect(res.status).toBe(401);
    expect(r.bridgeUpgrades).toHaveLength(0);
    expect(r.logs).toEqual([{ route: 'bridge', status: 401, kind: 'token' }]);
    expect(JSON.stringify(r.logs)).not.toContain(BRIDGE_TOKEN);
  });

  it('426 without a WebSocket upgrade (token right)', async () => {
    const r = startRig();
    const res = await r.fetch('/bridge', { headers: { authorization: `Bearer ${BRIDGE_TOKEN}` } });
    expect(res.status).toBe(426);
    expect(r.bridgeUpgrades).toHaveLength(0);
  });

  it.each([
    ['own origin', BASE],
    ['empty', ''],
    ['null', 'null'],
  ])('403 when an Origin header is present (%s; browsers cannot open the bridge socket)', async (_n, origin) => {
    const r = startRig();
    const res = await r.fetch('/bridge', { headers: { ...UPGRADE, authorization: `Bearer ${BRIDGE_TOKEN}`, origin } });
    expect(res.status).toBe(403);
    expect(r.bridgeUpgrades).toHaveLength(0);
  });

  it('right token + upgrade: handed to the DO without needing an Access JWT', async () => {
    const r = startRig();
    const res = await r.fetch('/bridge', { headers: { ...UPGRADE, authorization: `Bearer  ${BRIDGE_TOKEN}` } });
    expect(res.headers.get('x-fake-upgrade')).toBe('1');
    expect(r.bridgeUpgrades).toHaveLength(1);
    expect(r.logs).toContainEqual({ route: 'bridge', status: 200, kind: 'connect' });
  });

  it('a DO failure is a 500, not a crash', async () => {
    const r = startRig();
    r.failHub = true;
    const res = await r.fetch('/bridge', { headers: { ...UPGRADE, authorization: `Bearer ${BRIDGE_TOKEN}` } });
    expect(res.status).toBe(500);
  });

  it('the request forwarded to the DO carries no Authorization header', () => {
    const req = new Request(`${BASE}/bridge`, { headers: { ...UPGRADE, authorization: `Bearer ${BRIDGE_TOKEN}` } });
    const fwd = bridgeUpgradeRequest(req);
    expect(fwd.headers.get('authorization')).toBeNull();
    expect(fwd.headers.get('upgrade')).toBe('websocket');
    expect(new URL(fwd.url).pathname).toBe('/bridge');
  });

  it('/api/health reports bridgeOnline from the DO', async () => {
    const r = startRig();
    r.bridgeOnline = true;
    const { accessJwt } = await import('./helpers.js');
    const res = await r.fetch('/api/health', { headers: { 'cf-access-jwt-assertion': await accessJwt() } });
    expect(await res.json()).toEqual({ ok: true, bridgeOnline: true, events7d: 0 });
  });
});

describe('bridge messages', () => {
  it('stores a valid event as source local with the relay clock, acks it and fans it out once', () => {
    const { core, pushed } = hub();
    const e = makeEvent(1, { source: 'cloud', receivedAt: 1 } as never);
    const out = send(core, msg(e), NOW0 + 777);
    expect(parsed(out)).toEqual({ type: 'ack', id: e.id });
    expect(out.log).toEqual({ route: 'bridge', status: 204, kind: 'tool.start', id: e.id.slice(0, 8) });
    const stored = core.eventsAfter(0, 10);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.event.source).toBe('local');
    expect(stored[0]?.event.receivedAt).toBe(NOW0 + 777);
    expect(pushed).toHaveLength(1);
    expect(core.sessionList().sessions[0]?.key).toBe(`local:${e.sessionId}`);
  });

  it('a resent event (same id) is acked again but stored and fanned out only once', () => {
    const { core, pushed } = hub();
    const e = makeEvent(2, { source: 'local' });
    for (let i = 0; i < 3; i += 1) expect(parsed(send(core, msg(e)))).toEqual({ type: 'ack', id: e.id });
    expect(core.eventsAfter(0, 10)).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  it('runs the core second redaction pass (cleanEvent), like /ingest', () => {
    const { core } = hub();
    const ghp = 'ghp_' + 'A1b2C3d4'.repeat(5);
    const e = makeEvent(3, { text: `use ${ghp} now`, tool: { name: 'Bash', useId: 'toolu_3', summary: `curl -H "Authorization: Bearer ${ghp}" x` } });
    expect(parsed(send(core, msg(e)))).toMatchObject({ type: 'ack' });
    const text = JSON.stringify(core.eventsAfter(0, 10));
    expect(text).not.toContain(ghp);
    expect(text).toContain('[redacted]');
  });

  it('a schema-invalid event is rejected with its id (the bridge drops it), nothing stored', () => {
    const { core } = hub();
    const e = { ...makeEvent(4), kind: 'nope' };
    const out = send(core, msg(e));
    expect(parsed(out)).toEqual({ type: 'reject', id: e.id, code: 'invalid_event' });
    expect(core.eventsAfter(0, 10)).toHaveLength(0);
  });

  it('an id that does not look like an id is never echoed back', () => {
    const { core } = hub();
    const out = send(core, msg({ ...makeEvent(5), id: '<script>', kind: 'nope' }));
    expect(parsed(out)).toEqual({ type: 'reject', id: null, code: 'invalid_event' });
  });

  it.each([
    ['not JSON', '{', 'invalid_json'],
    ['a JSON array', '[1]', 'unknown_type'],
    ['another type', JSON.stringify({ type: 'auth', token: 'x' }), 'unknown_type'],
    ['no event', JSON.stringify({ type: 'event' }), 'invalid_event'],
  ])('%s -> reject (%s)', (_n, text, code) => {
    const { core } = hub();
    expect(parsed(send(core, text))).toMatchObject({ type: 'reject', code });
  });

  it('a binary frame closes the socket with 1003', () => {
    const { core } = hub();
    expect(send(core, new ArrayBuffer(4)).close?.code).toBe(CLOSE_UNSUPPORTED);
  });

  it('a message over the cap closes with 1009 (UTF-8 bytes, not UTF-16 units)', () => {
    const { core } = hub();
    expect(send(core, 'x'.repeat(MAX_BRIDGE_MESSAGE_BYTES + 1)).close?.code).toBe(CLOSE_TOO_BIG);
    // 3 bytes per char: under the cap in .length, over it in bytes.
    const cjk = '一'.repeat(Math.floor(MAX_BRIDGE_MESSAGE_BYTES / 3) + 10);
    expect(cjk.length).toBeLessThan(MAX_BRIDGE_MESSAGE_BYTES);
    expect(send(core, cjk).close?.code).toBe(CLOSE_TOO_BIG);
    // Exactly at the cap is not closed (it is just not valid JSON).
    expect(send(core, 'x'.repeat(MAX_BRIDGE_MESSAGE_BYTES)).close).toBeUndefined();
  });

  it(`rate limit: event ${LIMITS.bridge + 1} in one minute gets 'retry' with Retry-After seconds; ingest's bucket is separate`, () => {
    const { core } = hub();
    for (let i = 0; i < LIMITS.bridge; i += 1) expect(parsed(send(core, msg(makeEvent(i))))).toMatchObject({ type: 'ack' });
    const over = makeEvent(99_999);
    const out = parsed(send(core, msg(over))) as { type: string; id: string; retryAfterSec: number };
    expect(out).toMatchObject({ type: 'retry', id: over.id });
    expect(out.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(out.retryAfterSec).toBeLessThanOrEqual(60);
    expect(core.ingest({ ...makeEvent(123_456), receivedAt: NOW0 }, 'ingest', NOW0).status).toBe('stored');
    // Next minute: accepted again.
    expect(parsed(send(core, msg(over), NOW0 + 60_000))).toEqual({ type: 'ack', id: over.id });
  });

  it(`L-2: rejected frames count in the bridge bucket; past ${LIMITS.bridge}/min the socket closes with 1008`, () => {
    const { core } = hub();
    for (let i = 0; i < LIMITS.bridge; i += 1) expect(parsed(send(core, '{'))).toMatchObject({ type: 'reject', code: 'invalid_json' });
    for (const junk of ['{', '[1]', msg({ ...makeEvent(1), kind: 'nope' })]) {
      const out = send(core, junk);
      expect(out.reply).toBeUndefined();
      expect(out.close).toEqual({ code: CLOSE_POLICY, reason: 'too many invalid messages' });
      expect(out.log).toEqual({ route: 'bridge', status: CLOSE_POLICY, kind: 'reject_flood' });
    }
    // Same bucket: a valid event in that minute is told to retry (not lost), next minute is fine.
    expect(parsed(send(core, msg(makeEvent(2))))).toMatchObject({ type: 'retry' });
    expect(parsed(send(core, '{', NOW0 + 60_000))).toMatchObject({ type: 'reject' });
    expect(parsed(send(core, msg(makeEvent(2)), NOW0 + 60_000))).toMatchObject({ type: 'ack' });
  });

  it('L-2: valid events still use up the bucket for rejects too (one shared 1200/min)', () => {
    const { core } = hub();
    for (let i = 0; i < LIMITS.bridge; i += 1) send(core, msg(makeEvent(i)));
    expect(send(core, '{').close?.code).toBe(CLOSE_POLICY);
  });

  it('a store that throws answers retry (the bridge keeps the event)', () => {
    const e = makeEvent(7);
    const out = handleBridgeMessage(
      msg(e),
      () => {
        throw new Error('disk');
      },
      NOW0,
      () => ({ ok: true }),
    );
    expect(JSON.parse(out.reply ?? '')).toEqual({ type: 'retry', id: e.id, retryAfterSec: 5 });
  });

  it('log lines never carry event text', () => {
    const { core } = hub();
    const e = makeEvent(8, { text: 'very private words' });
    const out = send(core, msg(e));
    expect(JSON.stringify(out.log)).not.toContain('private');
  });
});

describe('L-2: reject log throttle', () => {
  const reject = (kind = 'invalid_json'): LogFields => ({ route: 'bridge', status: 400, kind });

  it('first reject per minute is logged, the rest become one summary line when the next window starts', () => {
    const lines: LogFields[] = [];
    const t = new RejectLogThrottle((f) => lines.push(f));
    const w0 = NOW0 - (NOW0 % 60_000);
    for (let i = 0; i < 500; i += 1) t.write(reject(), w0 + i);
    expect(lines).toEqual([reject()]);
    t.flush(w0 + 59_999); // same window: nothing yet
    expect(lines).toHaveLength(1);
    t.write(reject('unknown_type'), w0 + 60_000);
    expect(lines).toEqual([reject(), { route: 'bridge', status: 'rejects_suppressed', kind: '499' }, reject('unknown_type')]);
  });

  it('flush (DO alarm) writes the summary once a window is over; nothing when nothing was suppressed', () => {
    const lines: LogFields[] = [];
    const t = new RejectLogThrottle((f) => lines.push(f));
    const w0 = NOW0 - (NOW0 % 60_000);
    t.write(reject(), w0);
    t.write({ route: 'bridge', status: CLOSE_POLICY, kind: 'reject_flood' }, w0 + 1);
    t.flush(w0 + 60_000);
    t.flush(w0 + 120_000);
    expect(lines).toEqual([reject(), { route: 'bridge', status: 'rejects_suppressed', kind: '1' }]);
  });

  it('acks, retries and closes other than 1008 are never throttled', () => {
    const lines: LogFields[] = [];
    const t = new RejectLogThrottle((f) => lines.push(f));
    for (let i = 0; i < 5; i += 1) {
      t.write({ route: 'bridge', status: 204, kind: 'tool.start', id: 'abcdefgh' }, NOW0);
      t.write({ route: 'bridge', status: 429, kind: 'tool.start' }, NOW0);
      t.write({ route: 'bridge', status: 1009, kind: 'too_large' }, NOW0);
    }
    expect(lines).toHaveLength(15);
  });
});

describe('bridge liveness', () => {
  it('last seen = the later of connect time and the last answered ping', () => {
    expect(bridgeLastSeen({ openedAt: 100 }, null)).toBe(100);
    expect(bridgeLastSeen({ openedAt: 100 }, 500)).toBe(500);
    expect(bridgeLastSeen(null, 500)).toBe(500);
    expect(bridgeLastSeen('junk', null)).toBe(-Infinity);
  });

  it(`fresh for ${BRIDGE_STALE_MS} ms`, () => {
    expect(bridgeFresh(NOW0, NOW0 + BRIDGE_STALE_MS - 1)).toBe(true);
    expect(bridgeFresh(NOW0, NOW0 + BRIDGE_STALE_MS)).toBe(false);
    expect(bridgeFresh(-Infinity, NOW0)).toBe(false);
  });

  it('status message for the UI', () => {
    expect(JSON.parse(bridgeStatusMessage(true))).toEqual({ type: 'bridge', online: true });
    expect(JSON.parse(bridgeStatusMessage(false))).toEqual({ type: 'bridge', online: false });
  });
});

function fakeStorage(alarm: number | null = null): AlarmStorage & { alarm: number | null; kv: Map<string, unknown>; sets: number[] } {
  const s = {
    alarm,
    kv: new Map<string, unknown>(),
    sets: [] as number[],
    getAlarm: () => Promise.resolve(s.alarm),
    setAlarm: (t: number) => {
      s.alarm = t;
      s.sets.push(t);
      return Promise.resolve();
    },
    get: (k: string) => Promise.resolve(s.kv.get(k)),
    put: (k: string, v: number) => {
      s.kv.set(k, v);
      return Promise.resolve();
    },
  };
  return s;
}

describe('one DO alarm for retention + the bridge check', () => {
  it('wantedAlarm: retention time, or within BRIDGE_CHECK_MS while a bridge is connected', () => {
    expect(wantedAlarm(NOW0 + RETENTION_INTERVAL_MS, false, NOW0)).toBe(NOW0 + RETENTION_INTERVAL_MS);
    expect(wantedAlarm(NOW0 + RETENTION_INTERVAL_MS, true, NOW0)).toBe(NOW0 + BRIDGE_CHECK_MS);
    expect(wantedAlarm(NOW0 + 10, true, NOW0)).toBe(NOW0 + 10);
  });

  it('first start: retention due in 24 h, alarm set to it', async () => {
    const st = fakeStorage();
    await scheduleHubAlarm(st, NOW0, false);
    expect(st.kv.get(RETENTION_AT_KEY)).toBe(NOW0 + RETENTION_INTERVAL_MS);
    expect(st.alarm).toBe(NOW0 + RETENTION_INTERVAL_MS);
  });

  it('a pre-V1-04 alarm (no retentionAt key) is kept when it is sooner', async () => {
    const st = fakeStorage(NOW0 + 1000);
    await scheduleHubAlarm(st, NOW0, false);
    expect(st.alarm).toBe(NOW0 + 1000);
  });

  describe('L-1 migration: a pre-V1-04 alarm becomes the retention due time', () => {
    const H5 = 5 * 60 * 60 * 1000;

    it('old daily alarm at +5 h, bridge connects: retention still runs at +5 h (not +24 h), then daily', async () => {
      const st = fakeStorage(NOW0 + H5);
      await scheduleHubAlarm(st, NOW0, true); // constructor with the bridge online
      expect(st.kv.get(RETENTION_AT_KEY)).toBe(NOW0 + H5);
      expect(st.alarm).toBe(NOW0 + BRIDGE_CHECK_MS);
      const { core } = hub();
      core.ingest({ ...makeEvent(1), receivedAt: NOW0 - RETENTION_MS }, 'ingest', NOW0);
      const logs: LogFields[] = [];
      const run = (t: number): Promise<void> => runHubAlarm({ core, storage: st, now: t, log: (f) => logs.push(f), checkBridge: () => true });
      // Bridge checks before +5 h: no retention.
      for (let t = NOW0 + BRIDGE_CHECK_MS; t < NOW0 + H5; t += 60 * 60 * 1000) await run(t);
      expect(logs).toEqual([]);
      await run(NOW0 + H5);
      expect(logs).toEqual([{ route: 'retention', status: 'events=1 sessions=1' }]);
      expect(st.kv.get(RETENTION_AT_KEY)).toBe(NOW0 + H5 + RETENTION_INTERVAL_MS);
    });

    it('old daily alarm at +5 h, no bridge: the alarm stays at +5 h', async () => {
      const st = fakeStorage(NOW0 + H5);
      await scheduleHubAlarm(st, NOW0, false);
      expect(st.kv.get(RETENTION_AT_KEY)).toBe(NOW0 + H5);
      expect(st.alarm).toBe(NOW0 + H5);
    });

    it('old 60 s "more" alarm: retention continues at 60 s', async () => {
      const st = fakeStorage(NOW0 + 60_000);
      await scheduleHubAlarm(st, NOW0, true);
      expect(st.kv.get(RETENTION_AT_KEY)).toBe(NOW0 + 60_000);
      expect(st.alarm).toBe(NOW0 + BRIDGE_CHECK_MS);
      const { core } = hub();
      const logs: LogFields[] = [];
      await runHubAlarm({ core, storage: st, now: NOW0 + BRIDGE_CHECK_MS, log: (f) => logs.push(f), checkBridge: () => true });
      expect(logs).toEqual([]);
      await runHubAlarm({ core, storage: st, now: NOW0 + 60_000, log: (f) => logs.push(f), checkBridge: () => true });
      expect(logs).toHaveLength(1);
    });

    it('the old alarm firing first (handler before any schedule): retention runs now', async () => {
      const st = fakeStorage(NOW0); // the running old alarm still reads as set
      const { core } = hub();
      const logs: LogFields[] = [];
      await runHubAlarm({ core, storage: st, now: NOW0, log: (f) => logs.push(f), checkBridge: () => false });
      expect(logs).toHaveLength(1);
      expect(st.kv.get(RETENTION_AT_KEY)).toBe(NOW0 + RETENTION_INTERVAL_MS);
      expect(st.alarm).toBe(NOW0 + RETENTION_INTERVAL_MS);
    });

    it('an existing retentionAt is never overwritten by the current alarm', async () => {
      const st = fakeStorage(NOW0 + BRIDGE_CHECK_MS);
      st.kv.set(RETENTION_AT_KEY, NOW0 + H5);
      await scheduleHubAlarm(st, NOW0, true);
      expect(st.kv.get(RETENTION_AT_KEY)).toBe(NOW0 + H5);
    });
  });

  it('a bridge connecting pulls a far alarm in to the check interval', async () => {
    const st = fakeStorage();
    await scheduleHubAlarm(st, NOW0, false);
    await scheduleHubAlarm(st, NOW0 + 5, true);
    expect(st.alarm).toBe(NOW0 + 5 + BRIDGE_CHECK_MS);
    expect(st.kv.get(RETENTION_AT_KEY)).toBe(NOW0 + RETENTION_INTERVAL_MS);
  });

  it('alarm with a live bridge, retention not due: no retention, back in BRIDGE_CHECK_MS', async () => {
    const st = fakeStorage();
    await scheduleHubAlarm(st, NOW0, true);
    const { core } = hub();
    core.ingest({ ...makeEvent(1), receivedAt: NOW0 - RETENTION_MS - 1 }, 'ingest', NOW0);
    const logs: LogFields[] = [];
    const t = NOW0 + BRIDGE_CHECK_MS;
    await runHubAlarm({ core, storage: st, now: t, log: (f) => logs.push(f), checkBridge: () => true });
    expect(logs).toEqual([]);
    expect(core.eventsAfter(0, 10)).toHaveLength(1);
    expect(st.alarm).toBe(t + BRIDGE_CHECK_MS);
  });

  it('alarm when retention is due: runs it, next retention +24 h; bridge gone: alarm goes back to retention only', async () => {
    const st = fakeStorage();
    await scheduleHubAlarm(st, NOW0, true);
    const { core } = hub();
    core.ingest({ ...makeEvent(1), receivedAt: NOW0 - RETENTION_MS }, 'ingest', NOW0);
    const logs: LogFields[] = [];
    const t = NOW0 + RETENTION_INTERVAL_MS;
    let checked = 0;
    await runHubAlarm({
      core,
      storage: st,
      now: t,
      log: (f) => logs.push(f),
      checkBridge: () => {
        checked += 1;
        return false;
      },
    });
    expect(checked).toBe(1);
    expect(logs).toEqual([{ route: 'retention', status: 'events=1 sessions=1' }]);
    expect(st.kv.get(RETENTION_AT_KEY)).toBe(t + RETENTION_INTERVAL_MS);
    expect(st.alarm).toBe(t + RETENTION_INTERVAL_MS);
  });

  it('the alarm handler always sets the next alarm, even if the running one still reads as set', async () => {
    const st = fakeStorage();
    await scheduleHubAlarm(st, NOW0, true);
    const { core } = hub();
    const t = NOW0 + BRIDGE_CHECK_MS;
    st.alarm = t; // still "set" while it runs
    await runHubAlarm({ core, storage: st, now: t, log: () => undefined, checkBridge: () => true });
    expect(st.alarm).toBe(t + BRIDGE_CHECK_MS);
  });
});
