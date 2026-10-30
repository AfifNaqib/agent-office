// V1-01 POST /ingest under plain Node (Hono app + HubCore on node:sqlite).
// The same paths run against real workerd in workerd.test.ts.
import {
  MAX_FUTURE_SKEW_MS,
  bufferPush,
  cleanEvent,
  fingerprint,
  initialReorderState,
  initialSessionsState,
  lobby,
  normalize,
  reduceSessions,
  type OfficeEvent,
} from '@agent-office/core';
import { describe, expect, it } from 'vitest';
import { LIMITS, WINDOW_MS } from '../src/ratelimit.js';
import { BASE, NOW0, TOKEN, WRONG, accessJwt, makeEvent, startRig } from './helpers.js';

function count(rig: ReturnType<typeof startRig>, table: string): number {
  return (rig.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('AC: authorization (A3.2, A3.6 D2)', () => {
  it('no Authorization -> 401, nothing stored, log has kind only', async () => {
    const r = startRig();
    const res = await r.post(makeEvent(1, { text: 'body-text-marker' }), { auth: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'Missing or invalid token' } });
    expect(count(r, 'events')).toBe(0);
    expect(count(r, 'sessions')).toBe(0);
    expect(r.logs).toEqual([{ route: 'ingest', status: 401, kind: 'tool.start' }]);
  });

  it('a header-less session.start is never accepted', async () => {
    const r = startRig();
    const res = await r.post(makeEvent(1, { kind: 'session.start', tool: undefined }), { auth: null });
    expect(res.status).toBe(401);
    expect(count(r, 'events')).toBe(0);
    expect(r.logs).toEqual([{ route: 'ingest', status: 401, kind: 'session.start' }]);
  });

  it.each([
    ['wrong token', `Bearer ${WRONG}`],
    ['token prefix only', `Bearer ${TOKEN.slice(0, -1)}`],
    ['token plus extra', `Bearer ${TOKEN}x`],
    ['two tokens', `Bearer ${TOKEN} ${TOKEN}`],
    ['Basic scheme', `Basic ${TOKEN}`],
    ['no scheme', TOKEN],
    ['empty Bearer', 'Bearer '],
  ])('%s -> 401, nothing stored', async (_name, auth) => {
    const r = startRig();
    expect((await r.post(makeEvent(1), { auth })).status).toBe(401);
    expect(count(r, 'events')).toBe(0);
  });

  it('the scheme is case-insensitive', async () => {
    const r = startRig();
    expect((await r.post(makeEvent(1), { auth: `bearer ${TOKEN}` })).status).toBe(204);
  });

  it('unknown or garbage kinds are logged as "-"; logs never hold the body, token or text', async () => {
    const r = startRig();
    await r.post({ kind: 'evil<script>', text: 'body-text-marker' }, { auth: `Bearer ${WRONG}` });
    await r.post('not json body-text-marker', { auth: null });
    await r.post(makeEvent(2, { text: 'my prompt body-text-marker' }));
    const all = JSON.stringify(r.logs);
    for (const bad of [TOKEN, WRONG, 'body-text-marker', 'evil', 'my prompt', 'portfolio', 'src/a.ts']) expect(all).not.toContain(bad);
    expect(r.logs[0]).toEqual({ route: 'ingest', status: 401, kind: '-' });
    expect(r.logs[1]).toEqual({ route: 'ingest', status: 401, kind: '-' });
    expect(r.logs[2]).toEqual({ route: 'ingest', status: 204, kind: 'tool.start', id: makeEvent(2).id.slice(0, 8) });
  });

  it.each([
    ['unset', {}],
    ['empty', { INGEST_TOKEN: '' }],
    ['too short', { INGEST_TOKEN: 'short-token' }],
  ])('INGEST_TOKEN %s -> 503 for everyone (fails closed)', async (_name, env) => {
    const r = startRig(env);
    expect((await r.post(makeEvent(1), { auth: 'Bearer short-token' })).status).toBe(503);
    expect((await r.post(makeEvent(1), { auth: 'Bearer ' })).status).toBe(503);
    expect(count(r, 'events')).toBe(0);
  });
});

describe('AC: 400 / 413 paths', () => {
  it.each([
    ['wrong content type', makeEvent(1), 'text/plain', 'bad_content_type'],
    ['no content type', makeEvent(1), null, 'bad_content_type'],
    ['invalid JSON', '{"v":1,', 'application/json', 'invalid_json'],
    ['array body', [makeEvent(1)], 'application/json', 'invalid_event'],
    ['null body', null, 'application/json', 'invalid_event'],
    ['schema failure', { ...makeEvent(1), kind: 'nope' }, 'application/json', 'invalid_event'],
    ['unknown field', { ...makeEvent(1), extra: 1 }, 'application/json', 'invalid_event'],
    ['bad id', { ...makeEvent(1), id: 'x' }, 'application/json', 'invalid_event'],
    ['path in sessionId', { ...makeEvent(1), sessionId: '../x' }, 'application/json', 'invalid_event'],
  ])('%s -> 400 %s', async (_name, body, contentType, code) => {
    const r = startRig();
    const res = await r.post(body, { contentType });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    expect(count(r, 'events')).toBe(0);
  });

  it('invalid UTF-8 -> 400', async () => {
    const r = startRig();
    const res = await r.fetch('/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    expect(res.status).toBe(400);
  });

  it('a body over 64 KB -> 413 (declared length)', async () => {
    const r = startRig();
    const res = await r.post({ ...makeEvent(1), text: 'a'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(count(r, 'events')).toBe(0);
  });

  it('a streamed body over 64 KB with no Content-Length -> 413', async () => {
    const r = startRig();
    const chunk = new TextEncoder().encode('a'.repeat(16 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent >= 6) ctrl.close();
        else {
          sent += 1;
          ctrl.enqueue(chunk);
        }
      },
    });
    const res = await r.fetch('/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    });
    expect(res.status).toBe(413);
  });

  it('exactly 64 KB is accepted by the cap (then judged by the schema)', async () => {
    const r = startRig();
    const base = JSON.stringify(makeEvent(1));
    const padded = base.slice(0, -1) + ' '.repeat(64 * 1024 - base.length) + '}';
    expect(new TextEncoder().encode(padded).length).toBe(64 * 1024);
    expect((await r.post(padded)).status).toBe(204);
  });
});

describe('AC: 429 rate limit (600 / minute)', () => {
  it('the 601st event in one minute gets 429 with Retry-After; the next minute is open again', async () => {
    const r = startRig();
    r.clock.now = NOW0 - (NOW0 % WINDOW_MS) + 15_000;
    for (let i = 0; i < LIMITS.ingest; i++) expect((await r.post(makeEvent(i))).status).toBe(204);
    const res = await r.post(makeEvent(10_000));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('45');
    expect(count(r, 'events')).toBe(LIMITS.ingest);
    r.clock.now += 45_000;
    expect((await r.post(makeEvent(10_000))).status).toBe(204);
  });

  it('unauthenticated requests do not use up the budget', async () => {
    const r = startRig();
    for (let i = 0; i < LIMITS.ingest + 5; i++) await r.post(makeEvent(i), { auth: null });
    expect((await r.post(makeEvent(1))).status).toBe(204);
  });
});

describe('AC: dedupe, source, receivedAt', () => {
  it('the same id twice -> 204 both times, one row', async () => {
    const r = startRig();
    expect((await r.post(makeEvent(1))).status).toBe(204);
    r.clock.now += 1000;
    expect((await r.post(makeEvent(1, { text: 'changed' }))).status).toBe(204);
    expect(count(r, 'events')).toBe(1);
    expect(r.stored()[0]?.receivedAt).toBe(NOW0);
    expect(r.logs.map((l) => l.status)).toEqual([204, 'duplicate']);
  });

  it('source is forced to cloud and receivedAt comes from the relay clock', async () => {
    const r = startRig();
    r.clock.now = NOW0 + 777;
    expect((await r.post({ ...makeEvent(1, { source: 'local' }), receivedAt: 1 })).status).toBe(204);
    const [e] = r.stored();
    expect(e?.source).toBe('cloud');
    expect(e?.receivedAt).toBe(NOW0 + 777);
    const row = r.db.prepare('SELECT session_key, received_at FROM events').get() as { session_key: string; received_at: number };
    expect(row).toEqual({ session_key: `cloud:${makeEvent(1).sessionId}`, received_at: NOW0 + 777 });
  });

  // L-1 (plan A1 AC): a client cannot pick its own receivedAt, and a far-future
  // emittedAt is bounded by core bufferPush against the relay's receivedAt.
  it('forged receivedAt + far-future emittedAt: relay clock stored, core clamps emittedAt to receivedAt + 60 s', async () => {
    const r = startRig();
    r.clock.now = NOW0 + 4242;
    const future = NOW0 + 365 * 24 * 60 * 60 * 1000;
    expect((await r.post({ ...makeEvent(1, { emittedAt: future }), receivedAt: future })).status).toBe(204);
    const [e] = r.stored();
    expect(e?.receivedAt).toBe(NOW0 + 4242);
    expect(e?.emittedAt).toBe(future); // stored as sent; clients clamp on read
    const row = r.db.prepare('SELECT received_at FROM events').get() as { received_at: number };
    expect(row.received_at).toBe(NOW0 + 4242);
    // A client that loaded this from history (its own clock far later) still clamps to the relay time.
    const buf = bufferPush(initialReorderState(), e as OfficeEvent, NOW0 + 9 * 24 * 60 * 60 * 1000);
    expect(buf.pending[0]?.event.emittedAt).toBe(NOW0 + 4242 + MAX_FUTURE_SKEW_MS);
    // The session row uses the same clamp.
    expect(r.core.sessions()[0]?.last_event_at).toBe(NOW0 + 4242 + MAX_FUTURE_SKEW_MS);
  });

  it('a bad receivedAt from the client is ignored, not a 400', async () => {
    const r = startRig();
    expect((await r.post({ ...makeEvent(1), receivedAt: 'yesterday' })).status).toBe(204);
  });

  it('store failure -> 500, logged without detail', async () => {
    const r = startRig();
    r.failHub = true;
    const res = await r.post(makeEvent(1));
    expect(res.status).toBe(500);
    expect(r.logs).toEqual([{ route: 'ingest', status: 500, kind: 'tool.start' }]);
  });
});

describe('AC: second redaction pass; stored payload re-passes redact unchanged', () => {
  const secret = `sk-ant-${'a1B2c3D4'.repeat(6)}`;
  const gh = `ghp_${'Zy9Xw8Vu7T'.repeat(4)}`;

  it('secrets in text, summaries, names and ids never reach the store', async () => {
    const r = startRig();
    const e = makeEvent(1, {
      sessionId: `s-${gh}`,
      repo: `repo-${secret}`,
      text: `hello password=hunter2 and ${secret}`,
      tool: { name: 'Bash', useId: `u-${secret}`, summary: `curl -H "Authorization: Bearer ${gh}" x` },
      actor: { kind: 'subagent', agentType: `coder‮${gh}`, agentId: `a-${gh}` },
    });
    const p = makeEvent(2, { kind: 'permission.request', tool: undefined, permission: { requestId: gh, toolName: `Bash ${gh}`, summary: `echo ${secret}` } });
    expect((await r.post(e)).status).toBe(204);
    expect((await r.post(p)).status).toBe(204);
    const dump = JSON.stringify(r.db.prepare('SELECT * FROM events').all()) + JSON.stringify(r.db.prepare('SELECT * FROM sessions').all());
    for (const bad of [secret, gh, 'hunter2', '‮', 'a1B2c3D4', 'Zy9Xw8Vu7T']) expect(dump).not.toContain(bad);
    expect(dump).toContain('[redacted]');
    const [first, second] = r.stored();
    expect(first).toMatchObject({ sessionId: 'redacted', actor: { agentId: 'redacted' }, tool: { useId: 'redacted' } });
    expect(second?.permission?.requestId).toBe('redacted');
    for (const s of r.stored()) expect(cleanEvent(s)).toEqual(s);
  });

  it('honest events come out unchanged: every observed hook fixture round-trips as a cloud event', async () => {
    const { loadFixtures } = await import('../../core/test/helpers/fixtures.js');
    const r = startRig();
    const sent: OfficeEvent[] = [];
    let n = 0;
    for (const f of loadFixtures().filter((x) => x.observed)) {
      n += 1;
      const id = await fingerprint('cloud', `${f.raw}${n}`);
      const e = normalize(f.payload, { id, emittedAt: NOW0 + n, source: 'cloud' });
      if (!e) continue;
      sent.push(e);
      expect((await r.post(e)).status, f.file).toBe(204);
    }
    expect(sent.length).toBeGreaterThan(50);
    const stored = r.stored();
    expect(stored.map((e) => ({ ...e, receivedAt: undefined }))).toEqual(sent.map((e) => ({ ...e, receivedAt: undefined })));
    for (const s of stored) expect(cleanEvent(s)).toEqual(s);
  });
});

describe('AC: a cloud session whose first accepted event is not session.start still appears', () => {
  it('lobby (core reducers over the stored history) shows it with source cloud and an Open link', async () => {
    const r = startRig();
    // session.start was rejected (no header, A3.6 D2); the next event carries the Bearer.
    expect((await r.post(makeEvent(1, { kind: 'session.start', tool: undefined }), { auth: null })).status).toBe(401);
    expect((await r.post(makeEvent(2, { kind: 'prompt.submit', tool: undefined, text: 'build it' }))).status).toBe(204);
    expect((await r.post(makeEvent(3))).status).toBe(204);

    const state = r.stored().reduce(reduceSessions, initialSessionsState());
    const entries = lobby(state, NOW0 + 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: `cloud:${makeEvent(1).sessionId}`,
      source: 'cloud',
      status: 'live',
      repo: 'portfolio',
      remoteSessionId: 'cse_01AbCdEfGhIjKlMnOpQrStUv',
      openUrl: 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv',
      controllable: false,
      eventCount: 2,
    });
    expect(r.core.sessions()).toEqual([
      expect.objectContaining({ source: 'cloud', session_id: makeEvent(1).sessionId, status: 'live', repo: 'portfolio', started_at: entries[0]?.startedAt }),
    ]);
  });
});

describe('routes, headers, no CORS', () => {
  it('GET /api/health: ok, bridgeOnline, events7d only; behind Access since V1-02', async () => {
    const r = startRig();
    expect((await r.fetch('/api/health')).status).toBe(401);
    const res = await r.fetch('/api/health', { headers: { 'cf-access-jwt-assertion': await accessJwt() } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bridgeOnline: false, events7d: 0 });
  });

  it.each([
    ['GET /ingest', '/ingest', 'GET', 405],
    ['PUT /ingest', '/ingest', 'PUT', 405],
    ['look-alike /ingestx', '/ingestx', 'POST', 404],
    ['trailing slash', '/ingest/', 'POST', 404],
    ['unknown', '/api/nope', 'GET', 404],
    ['bridge with the INGEST token', '/bridge', 'GET', 401],
    ['POST /bridge', '/bridge', 'POST', 405],
    ['bridge look-alike', '/bridge/', 'GET', 404],
  ])('%s -> %d', async (_name, path, method, status) => {
    const r = startRig();
    // Bearer for the bypass paths; Access JWT + own Origin for the rest (V1-02).
    const headers = { authorization: `Bearer ${TOKEN}`, 'cf-access-jwt-assertion': await accessJwt(), origin: BASE };
    const res = await r.fetch(path, { method, headers });
    expect(res.status).toBe(status);
  });

  it('no Access-Control-* header on any response (including preflight); security headers everywhere', async () => {
    const r = startRig();
    const responses = [
      await r.post(makeEvent(1)),
      await r.post(makeEvent(2), { auth: null, headers: { origin: 'https://evil.example' } }),
      await r.fetch('/ingest', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }),
      await r.fetch('/api/health', { headers: { origin: 'https://evil.example' } }),
      await r.fetch('/nope'),
    ];
    for (const res of responses) {
      expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });
});
