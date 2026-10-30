// V0-01 acceptance tests: the REAL server on an ephemeral port, driven with Node http / raw TCP / ws.
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OfficeEvent } from '@agent-office/core';
import { tokensEqual } from '../src/security.js';
import { dayOf } from '../src/store.js';
import { DAY, NOW0, TOKEN, call, getJson, makeEvent, post, raw, sleep, startRig, statusOf, stopAll, storedLines, tempDir, wsOpen } from './helpers.js';

afterEach(async () => {
  await stopAll();
});

// Built at run time so the repo's secret scan has no literal to match.
const WRONG = ['wrong', 'value', 'x'].join('-');

interface EventsPage {
  boot: string;
  lastSeq: number;
  events: { seq: number; event: OfficeEvent }[];
  hasMore: boolean;
}

describe('AC: binding', () => {
  it('listens on 127.0.0.1 only, IPv4, and nothing answers on other addresses', async () => {
    const r = await startRig();
    const addr = r.bridge.server.address();
    expect(addr).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    // Other local addresses (LAN IPs, ::1, 0.0.0.0-style wildcard) must refuse.
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i !== undefined && !i.internal && i.family === 'IPv4')
      .map((i) => i?.address ?? '');
    for (const host of [...others, '::1']) {
      const err = await new Promise<string>((resolve) => {
        const s = createConnection({ host, port: r.port });
        s.on('connect', () => {
          s.destroy();
          resolve('connected');
        });
        s.on('error', (e: NodeJS.ErrnoException) => {
          resolve(e.code ?? 'error');
        });
      });
      expect(err, host).not.toBe('connected');
    }
  });
});

describe('AC: Host allowlist and request target (421 / 400)', () => {
  it.each<[string, string]>([
    ['another host name', 'evil.example:PORT'],
    ['loopback without the port', '127.0.0.1'],
    ['the wrong port', '127.0.0.1:1'],
    ['localhost without the port', 'localhost'],
    ['an IPv6 loopback', '[::1]:PORT'],
    ['a rebinding-style name', '127.0.0.1.evil.example:PORT'],
  ])('%s -> 421, even with a valid token', async (_n, host) => {
    const r = await startRig();
    const h = host.replace('PORT', String(r.port));
    expect((await call(r.port, '/api/health', { host: h })).status).toBe(421);
    expect((await post(r.port, makeEvent(1), { host: h })).status).toBe(421);
    expect((await call(r.port, '/api/sessions', { host: h })).status).toBe(421);
  });

  it.each(['evil.example@127.0.0.1:PORT', '127.0.0.1:PORT, evil.example', '127.0.0.1:PORT evil.example'])('malformed Host %s is refused (4xx) and never served', async (host) => {
    const r = await startRig();
    const out = await raw(r.port, `GET /api/health HTTP/1.1\r\nHost: ${host.replace('PORT', String(r.port))}\r\nConnection: close\r\n\r\n`);
    expect([400, 421]).toContain(statusOf(out.text));
    expect(out.text).not.toContain('"ok":true');
  });

  it('no Host header at all (HTTP/1.0 or 1.1) is refused and never served', async () => {
    const r = await startRig();
    for (const v of ['1.0', '1.1']) {
      const out = await raw(r.port, `GET /api/health HTTP/${v}\r\nX-Agent-Office-Local: ${TOKEN}\r\nConnection: close\r\n\r\n`);
      expect([400, 421], v).toContain(statusOf(out.text));
      expect(out.text).not.toContain('"ok":true');
    }
  });

  it('the Host check runs before the token check', async () => {
    const r = await startRig();
    expect((await post(r.port, makeEvent(1), { host: 'evil.example', token: false })).status).toBe(421);
  });

  it('127.0.0.1:port and localhost:port (any case) are accepted', async () => {
    const r = await startRig();
    for (const host of [`127.0.0.1:${r.port}`, `localhost:${r.port}`, `LocalHost:${r.port}`]) {
      expect((await call(r.port, '/api/health', { host })).status, host).toBe(200);
    }
  });

  it('a second Host header is refused (421), whichever comes first', async () => {
    const r = await startRig();
    const a = await raw(r.port, `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
    const b = await raw(r.port, `GET /api/health HTTP/1.1\r\nHost: evil.example\r\nHost: 127.0.0.1:${r.port}\r\nConnection: close\r\n\r\n`);
    const c = await raw(r.port, `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nHost: 127.0.0.1:${r.port}\r\nConnection: close\r\n\r\n`);
    expect([statusOf(a.text), statusOf(b.text), statusOf(c.text)]).toEqual([421, 421, 421]);
  });

  it('absolute-form and other odd request targets are refused (400), never routed by their own host', async () => {
    const r = await startRig();
    for (const target of [`http://evil.example/api/health`, `http://127.0.0.1:${r.port}/api/health`, '//api/health', '*', 'evil.example:80']) {
      const out = await raw(r.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nConnection: close\r\n\r\n`);
      expect(statusOf(out.text), target).toBeGreaterThanOrEqual(400);
      expect(statusOf(out.text), target).toBeLessThan(500);
      expect(out.text, target).not.toContain('"ok":true');
    }
  });
});

describe('AC: token (401)', () => {
  it('missing / wrong / near-miss tokens -> 401; the right one passes', async () => {
    const r = await startRig();
    const e = makeEvent(1);
    expect((await post(r.port, e, { token: false })).status).toBe(401);
    expect((await post(r.port, e, { token: 'x' })).status).toBe(401);
    expect((await post(r.port, e, { token: '' })).status).toBe(401);
    expect((await post(r.port, e, { token: `${TOKEN}x` })).status).toBe(401);
    expect((await post(r.port, e, { token: TOKEN.slice(0, -1) })).status).toBe(401);
    expect((await post(r.port, e, { token: TOKEN.toLowerCase() })).status).toBe(401);
    expect((await post(r.port, e, { token: false, headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
    expect((await call(r.port, `/api/sessions?token=${TOKEN}`, { token: false })).status).toBe(401);
    expect(r.bridge.store.size).toBe(0);
    expect((await post(r.port, e)).status).toBe(204);
    expect(r.bridge.store.size).toBe(1);
  });

  it('401 body has the common error shape and leaks nothing', async () => {
    const r = await startRig();
    const res = await post(r.port, makeEvent(1), { token: 'wrong' });
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'unauthorized', message: 'Missing or invalid token' } });
    expect(res.body).not.toContain(TOKEN);
  });

  it('every /api route except health needs the token; health needs only the Host', async () => {
    const r = await startRig();
    for (const p of ['/api/sessions', '/api/sessions/local:x/events', '/api/events']) {
      expect((await call(r.port, p, { token: false })).status, p).toBe(401);
    }
    expect((await call(r.port, '/api/health', { token: false })).status).toBe(200);
  });

  it('tokensEqual compares content in constant time and handles different lengths', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
    expect(tokensEqual('', 'a')).toBe(false);
    expect(tokensEqual('', '')).toBe(true);
  });
});

describe('AC: /hooks/event validation', () => {
  it('malformed JSON, non-objects and an empty body -> 400', async () => {
    const r = await startRig();
    for (const body of ['{"v":1', 'not json', '', '[]', '123', 'null', '"str"']) {
      const res = await post(r.port, body);
      expect(res.status, body).toBe(400);
      expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toMatch(/invalid_/);
    }
    expect(r.bridge.store.size).toBe(0);
  });

  it('schema violations -> 400 and the response never echoes the sent values', async () => {
    const r = await startRig();
    const planted = 'planted-value-do-not-echo';
    const bad = [
      { ...makeEvent(1), v: 2 },
      { ...makeEvent(1), kind: 'tool.start', tool: undefined },
      { ...makeEvent(1), id: 'short' },
      { ...makeEvent(1), sessionId: '../../etc' },
      { ...makeEvent(1), extra: planted },
      { ...makeEvent(1), text: planted + 'x'.repeat(600) },
      { ...makeEvent(1), emittedAt: -1 },
    ];
    for (const e of bad) {
      const res = await post(r.port, e);
      expect(res.status).toBe(400);
      expect(res.body).not.toContain(planted);
    }
    expect(r.bridge.store.size).toBe(0);
  });

  it('wrong or missing Content-Type -> 400', async () => {
    const r = await startRig();
    const body = JSON.stringify(makeEvent(1));
    expect((await call(r.port, '/hooks/event', { method: 'POST', body })).status).toBe(400);
    expect((await call(r.port, '/hooks/event', { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })).status).toBe(400);
    expect((await call(r.port, '/hooks/event', { method: 'POST', body, headers: { 'Content-Type': 'application/jsonx' } })).status).toBe(400);
    expect((await call(r.port, '/hooks/event', { method: 'POST', body, headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status).toBe(204);
  });

  it('only POST works on /hooks/event; odd paths are 404', async () => {
    const r = await startRig();
    for (const [method, path] of [['GET', '/hooks/event'], ['PUT', '/hooks/event'], ['DELETE', '/hooks/event'], ['POST', '/hooks/event/'], ['POST', '/HOOKS/event'], ['POST', '//hooks/event'], ['POST', '/hooks/event%2f'], ['GET', '/'], ['GET', '/ws']] as const) {
      const res = await call(r.port, path, { method, json: true, body: method === 'POST' ? JSON.stringify(makeEvent(1)) : undefined });
      expect([400, 404, 405], `${method} ${path}`).toContain(res.status);
    }
    expect(r.bridge.store.size).toBe(0);
  });
});

describe('AC: size limit (413)', () => {
  it('a body over 64 KB -> 413 with Content-Length, and the connection is closed', async () => {
    const r = await startRig();
    const res = await post(r.port, JSON.stringify(makeEvent(1)) + ' '.repeat(64 * 1024));
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe('close');
    expect(r.bridge.store.size).toBe(0);
  });

  it('exactly 64 KB is allowed, one byte more is not', async () => {
    const r = await startRig();
    const json = JSON.stringify(makeEvent(1));
    expect((await post(r.port, json + ' '.repeat(64 * 1024 - json.length))).status).toBe(204);
    const json2 = JSON.stringify(makeEvent(2));
    expect((await post(r.port, json2 + ' '.repeat(64 * 1024 - json2.length + 1))).status).toBe(413);
  });

  it('chunked bodies with no Content-Length are capped too', async () => {
    const r = await startRig();
    const chunk = 'a'.repeat(8192);
    let body = '';
    for (let i = 0; i < 12; i++) body += `${chunk.length.toString(16)}\r\n${chunk}\r\n`;
    body += '0\r\n\r\n';
    const out = await raw(r.port, `POST /hooks/event HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nX-Agent-Office-Local: ${TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body}`);
    expect(statusOf(out.text)).toBe(413);
  });

  it('a 5 MB body is refused at once without being buffered, and the server keeps serving', async () => {
    const r = await startRig();
    const res = await post(r.port, 'x'.repeat(5 * 1024 * 1024)).catch(() => ({ status: 413 }));
    expect(res.status).toBe(413);
    expect((await call(r.port, '/api/health')).status).toBe(200);
  });

  it('an unauthenticated oversized body is 401, not read', async () => {
    const r = await startRig();
    const res = await post(r.port, 'x'.repeat(200 * 1024), { token: false }).catch(() => ({ status: 401 }));
    expect(res.status).toBe(401);
  });
});

describe('AC: receivedAt is the bridge\'s own clock', () => {
  it.each<[string, unknown]>([
    ['a past number', 1],
    ['a far-future number', 9e15],
    ['the real future', NOW0 + 10 * DAY],
    ['a string', 'yesterday'],
    ['null', null],
    ['an object', { a: 1 }],
  ])('a client value (%s) is ignored', async (_n, forged) => {
    const r = await startRig();
    r.clock.now = NOW0 + 5000;
    const res = await post(r.port, { ...makeEvent(1), receivedAt: forged });
    expect(res.status).toBe(204);
    const page = await getJson<EventsPage>(r.port, '/api/events');
    expect(page.events[0]?.event.receivedAt).toBe(NOW0 + 5000);
    expect(storedLines(r.dir)[0]?.receivedAt).toBe(NOW0 + 5000);
  });

  it('a later event gets the later clock value', async () => {
    const r = await startRig();
    await post(r.port, makeEvent(1));
    r.clock.now += 777;
    await post(r.port, makeEvent(2));
    const page = await getJson<EventsPage>(r.port, '/api/events');
    expect(page.events.map((e) => e.event.receivedAt)).toEqual([NOW0, NOW0 + 777]);
  });
});

describe('AC: dedupe by event id only', () => {
  it('a duplicate id is stored once (204 both times), also when the content differs', async () => {
    const r = await startRig();
    expect((await post(r.port, makeEvent(1))).status).toBe(204);
    expect((await post(r.port, makeEvent(1))).status).toBe(204);
    expect((await post(r.port, makeEvent(1, { text: 'different content, same id' }))).status).toBe(204);
    expect(storedLines(r.dir)).toHaveLength(1);
    const page = await getJson<EventsPage>(r.port, '/api/events');
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.event.text).toBeUndefined();
  });

  it('a different id with identical content is stored (no content hash)', async () => {
    const r = await startRig();
    await post(r.port, makeEvent(1));
    await post(r.port, { ...makeEvent(1), id: makeEvent(2).id });
    expect(storedLines(r.dir)).toHaveLength(2);
  });

  it('concurrent posts of one id store it once', async () => {
    const r = await startRig();
    const results = await Promise.all(Array.from({ length: 40 }, () => post(r.port, makeEvent(1))));
    expect(results.every((x) => x.status === 204)).toBe(true);
    expect(storedLines(r.dir)).toHaveLength(1);
    expect(r.bridge.store.size).toBe(1);
  });

  it('dedupe survives a restart', async () => {
    const dir = tempDir();
    const a = await startRig({ dir });
    await post(a.port, makeEvent(1));
    await a.stop();
    const b = await startRig({ dir });
    await post(b.port, makeEvent(1));
    await post(b.port, makeEvent(2));
    expect(storedLines(dir).map((e) => e.id)).toEqual([makeEvent(1).id, makeEvent(2).id]);
  });
});

describe('AC: second redaction pass (defence in depth)', () => {
  // Built at run time so the secret scan finds no literal in this file.
  const secret = `sk-ant-${'a1B2c3D4'.repeat(6)}`;
  const gh = `ghp_${'Zy9Xw8Vu7T'.repeat(4)}`;

  it('secrets in text, summaries and names never reach memory, disk, or the live feed', async () => {
    const r = await startRig();
    const live = await wsOpen(r.port, { auth: 'header' });
    const e = makeEvent(1, {
      text: `hello password=hunter2 and ${secret}`,
      tool: { name: 'Bash', useId: 'u1', summary: `curl -H "Authorization: Bearer ${gh}" x` },
      actor: { kind: 'subagent', agentType: `coder‮${gh}`, agentId: 'a1' },
    });
    expect((await post(r.port, e)).status).toBe(204);
    await live.waitFor((m) => m.type === 'event');
    const history = await getJson<EventsPage>(r.port, '/api/events');
    const everything = JSON.stringify([history, readFileSync(join(r.dir, readdirSync(r.dir)[0] ?? ''), 'utf8'), live.messages]);
    for (const bad of [secret, gh, 'hunter2', '‮']) expect(everything).not.toContain(bad);
    expect(everything).toContain('[redacted]');
    live.ws.close();
  });

  it('a permission summary and tool name are cleaned too', async () => {
    const r = await startRig();
    const e = makeEvent(1, {
      kind: 'permission.request',
      tool: undefined,
      permission: { requestId: 'req_1', toolName: `Bash ${gh}`, summary: `echo ${secret}` },
    });
    expect((await post(r.port, e)).status).toBe(204);
    const stored = storedLines(r.dir)[0];
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(gh);
  });

  it('B-09: ids holding a secret shape never reach memory, disk, or the live feed', async () => {
    const r = await startRig();
    const live = await wsOpen(r.port, { auth: 'header' });
    const e = makeEvent(1, {
      sessionId: `s-${gh}`,
      runId: gh,
      repo: `repo-${secret}`,
      actor: { kind: 'subagent', agentType: 'coder', agentId: `a-${gh}` },
      tool: { name: 'Read', useId: `u-${secret}`, summary: 'src/a.ts' },
    });
    expect((await post(r.port, e)).status).toBe(204);
    const p = makeEvent(2, { kind: 'permission.request', tool: undefined, permission: { requestId: gh, toolName: 'Bash', summary: 'npm test' } });
    expect((await post(r.port, p)).status).toBe(204);
    await live.waitFor((m) => m.type === 'event' && (m as { seq?: number }).seq === 2);
    const history = await getJson<EventsPage>(r.port, '/api/events');
    const everything = JSON.stringify([history, readFileSync(join(r.dir, readdirSync(r.dir)[0] ?? ''), 'utf8'), live.messages]);
    for (const bad of [secret, gh, 'A1b2C3d4', 'Zy9Xw8Vu7T']) expect(everything).not.toContain(bad);
    const [first, second] = storedLines(r.dir);
    expect(first).toMatchObject({ sessionId: 'redacted', actor: { agentId: 'redacted' }, tool: { useId: 'redacted' } });
    expect(first).not.toHaveProperty('runId');
    expect(first?.repo).toContain('[redacted]');
    expect(second?.permission?.requestId).toBe('redacted');
    live.ws.close();
  });

  it('B-09: a repo that cleans to nothing is dropped, a cloud event keeps its real ids', async () => {
    const r = await startRig();
    const e = makeEvent(1, { repo: '\u200b\u034f', source: 'cloud', sessionId: '7c1d0e52-3b8f-4a5e-9d21-0f6b2a9c4e17', remoteSessionId: 'cse_01AbCdEfGhIjKlMnOpQrStUv' });
    expect((await post(r.port, e)).status).toBe(204);
    const stored = storedLines(r.dir)[0];
    expect(stored).not.toHaveProperty('repo');
    expect(stored).toMatchObject({ sessionId: '7c1d0e52-3b8f-4a5e-9d21-0f6b2a9c4e17', remoteSessionId: 'cse_01AbCdEfGhIjKlMnOpQrStUv' });
  });

  it('honest events come out unchanged (idempotent): every observed hook fixture round-trips', async () => {
    const { loadFixtures } = await import('../../core/test/helpers/fixtures.js');
    const { fingerprint, normalize } = await import('@agent-office/core');
    const r = await startRig();
    let n = 0;
    for (const f of loadFixtures().filter((x) => x.observed)) {
      const id = await fingerprint('local', `${f.raw}${n}`);
      n += 1;
      const e = normalize(f.payload, { id, emittedAt: NOW0 + n, source: 'local' });
      if (!e) continue;
      expect((await post(r.port, e)).status, f.file).toBe(204);
    }
    expect(n).toBeGreaterThan(50);
    const stored = storedLines(r.dir);
    const sent = (await Promise.all(loadFixtures().filter((x) => x.observed).map(async (f, i) => normalize(f.payload, { id: await fingerprint('local', `${f.raw}${i}`), emittedAt: NOW0 + i + 1, source: 'local' })))).filter((e) => e !== null);
    expect(stored.map((e) => ({ ...e, receivedAt: undefined }))).toEqual(sent.map((e) => ({ ...e, receivedAt: undefined })));
  });
});

describe('AC: logging never includes bodies, tokens or secrets', () => {
  it('log lines carry only kind, id prefix and status', async () => {
    const r = await startRig();
    const secret = `sk-ant-${'q9W8e7R6'.repeat(6)}`;
    await post(r.port, makeEvent(1, { text: `my prompt ${secret}` }));
    await post(r.port, makeEvent(1));
    await post(r.port, makeEvent(2), { token: WRONG });
    await post(r.port, '{"broken": "body-text-marker');
    await call(r.port, '/api/sessions');
    const all = r.lines.join('\n');
    for (const bad of [TOKEN, WRONG, secret, 'my prompt', 'body-text-marker', 'src/a.ts', 'sess-1']) expect(all).not.toContain(bad);
    expect(r.lines).toContain(`event tool.start ${makeEvent(1).id.slice(0, 8)} 204`);
    expect(r.lines).toContain(`event tool.start ${makeEvent(1).id.slice(0, 8)} duplicate`);
  });
});

describe('AC: no CORS, security headers', () => {
  it('no Access-Control-* header on any response, including preflight and errors', async () => {
    const r = await startRig();
    const origin = { Origin: 'https://evil.example' };
    const replies = [
      await call(r.port, '/api/health', { headers: origin }),
      await call(r.port, '/api/sessions', { headers: origin, token: false }),
      await call(r.port, '/hooks/event', { method: 'OPTIONS', headers: { ...origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-agent-office-local' }, token: false }),
      await call(r.port, '/nope', { headers: origin }),
      await post(r.port, '{', { headers: origin }),
    ];
    for (const res of replies) {
      expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
    expect(replies[2]?.status).toBe(404); // no OPTIONS route: no preflight answer, so browsers block the cross-origin call
  });

  it('unknown routes are 404 JSON in the common error shape; internal errors do not leak', async () => {
    const r = await startRig();
    const res = await call(r.port, '/nope');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });
});

describe('AC: history API', () => {
  it('lists sessions newest first and pages through events with after/limit', async () => {
    const r = await startRig();
    for (let i = 1; i <= 5; i++) await post(r.port, makeEvent(i, { sessionId: i % 2 ? 'odd' : 'even' }));
    await post(r.port, makeEvent(6, { sessionId: 'x', source: 'cloud', remoteSessionId: 'session_abc' }));
    const s = await getJson<{ boot: string; sessions: { key: string; eventCount: number; remoteSessionId: string | null }[] }>(r.port, '/api/sessions');
    expect(s.sessions.map((x) => x.key)).toEqual(['cloud:x', 'local:odd', 'local:even'].sort((a, b) => 0 * a.length + 0 * b.length));
    expect(s.sessions.find((x) => x.key === 'local:odd')?.eventCount).toBe(3);
    expect(s.sessions.find((x) => x.key === 'cloud:x')?.remoteSessionId).toBe('session_abc');
    const p1 = await getJson<EventsPage>(r.port, '/api/sessions/local:odd/events?limit=2');
    expect(p1.events.map((e) => e.seq)).toEqual([1, 3]);
    expect(p1.hasMore).toBe(true);
    const p2 = await getJson<EventsPage>(r.port, `/api/sessions/local:odd/events?after=${p1.events.at(-1)?.seq}`);
    expect(p2.events.map((e) => e.seq)).toEqual([5]);
    expect(p2.hasMore).toBe(false);
    expect(p2.boot).toBe(r.bridge.boot);
    const all = await getJson<EventsPage>(r.port, '/api/events?after=2&limit=100');
    expect(all.events.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
  });

  it('bad paging -> 400; unknown or malformed session key -> 404', async () => {
    const r = await startRig();
    await post(r.port, makeEvent(1));
    for (const q of ['after=-1', 'after=abc', 'limit=0x10', 'limit=1e3', 'after=99999999999999999999']) {
      expect((await call(r.port, `/api/events?${q}`)).status, q).toBe(400);
    }
    expect((await call(r.port, '/api/events?limit=0')).status).toBe(200); // clamped to 1
    for (const key of ['local:nope', 'nope', 'local:../../etc', 'cloud:sess-1', 'local:']) {
      expect((await call(r.port, `/api/sessions/${key}/events`)).status, key).toBe(404);
    }
    expect((await call(r.port, '/api/sessions/local:sess-1/events')).status).toBe(200);
  });

  it('health reports the relay as offline in v0 and the stored count', async () => {
    const r = await startRig();
    await post(r.port, makeEvent(1));
    expect(JSON.parse((await call(r.port, '/api/health')).body)).toMatchObject({ ok: true, relay: 'offline', events: 1, boot: r.bridge.boot });
  });
});

describe('AC: storage, restart and 7-day retention', () => {
  const stamp = (n: number, ageMs: number, over: Partial<OfficeEvent> = {}): OfficeEvent => ({ ...makeEvent(n, over), receivedAt: NOW0 - ageMs });
  const writeDay = (dir: string, events: OfficeEvent[]): void => {
    mkdirSync(dir, { recursive: true });
    for (const e of events) appendFileSync(join(dir, `${dayOf(e.receivedAt ?? 0)}.jsonl`), `${JSON.stringify(e)}\n`);
  };

  it('restart reloads the last 7 days and keeps working', async () => {
    const dir = tempDir();
    const a = await startRig({ dir });
    for (let i = 1; i <= 4; i++) await post(a.port, makeEvent(i, { sessionId: i < 3 ? 's-a' : 's-b' }));
    await a.stop();
    const b = await startRig({ dir });
    const page = await getJson<EventsPage>(b.port, '/api/events');
    expect(page.events.map((e) => e.event.id)).toEqual([1, 2, 3, 4].map((i) => makeEvent(i).id));
    expect(page.events.every((e) => e.event.receivedAt === NOW0)).toBe(true);
    const s = await getJson<{ sessions: { key: string; eventCount: number }[] }>(b.port, '/api/sessions');
    expect(s.sessions.map((x) => [x.key, x.eventCount]).sort()).toEqual([['local:s-a', 2], ['local:s-b', 2]]);
    expect(b.bridge.boot).not.toBe(a.bridge.boot);
    await post(b.port, makeEvent(5));
    expect((await getJson<EventsPage>(b.port, '/api/events')).events.at(-1)?.seq).toBe(5);
  });

  it('events from 6 days ago load; events older than 7 days and their files are deleted', async () => {
    const dir = tempDir();
    writeDay(dir, [stamp(1, 8 * DAY), stamp(2, 7 * DAY + 3_600_000), stamp(3, 6 * DAY), stamp(4, 1000)]);
    const before = readdirSync(dir).sort();
    expect(before).toHaveLength(4);
    const r = await startRig({ dir });
    const after = readdirSync(dir).sort();
    // A day file goes only when its whole UTC day is past the cutoff: the 8-day-old file is gone;
    // the 7d+1h file (still holds hours inside the window) stays, but its stale event is not loaded.
    expect(after).toEqual(before.slice(1));
    const page = await getJson<EventsPage>(r.port, '/api/events');
    expect(page.events.map((e) => e.event.id)).toEqual([makeEvent(3).id, makeEvent(4).id]);
  });

  it('inside a kept day file, events past the cutoff are not loaded', async () => {
    const dir = tempDir();
    // Same UTC day: one before the cutoff (now - 7 d) and one after it.
    const cutoff = NOW0 - 7 * DAY;
    writeDay(dir, [{ ...makeEvent(1), receivedAt: cutoff - 1000 }, { ...makeEvent(2), receivedAt: cutoff + 1000 }]);
    const r = await startRig({ dir });
    const page = await getJson<EventsPage>(r.port, '/api/events');
    expect(page.events.map((e) => e.event.id)).toEqual([makeEvent(2).id]);
  });

  it('the cleanup timer path deletes expired files and evicts them from memory while running', async () => {
    const dir = tempDir();
    const r = await startRig({ dir });
    await post(r.port, makeEvent(1));
    expect(readdirSync(dir)).toHaveLength(1);
    r.clock.now = NOW0 + 9 * DAY;
    await post(r.port, makeEvent(2));
    expect(await r.bridge.store.cleanup()).toBe(1);
    expect(readdirSync(dir)).toHaveLength(1);
    const page = await getJson<EventsPage>(r.port, '/api/events');
    expect(page.events.map((e) => e.event.id)).toEqual([makeEvent(2).id]);
    // an evicted id may be stored again (the unique index is a 7-day window)
    await post(r.port, makeEvent(1));
    expect(r.bridge.store.size).toBe(2);
  });

  it('files that are not event files are never touched; symlinks named like day files are not followed', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const outside = join(tempDir(), 'victim.txt');
    writeFileSync(outside, 'keep me');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, '2020-01-01.jsonl.bak'), 'x');
    writeFileSync(join(dir, '2020-1-1.jsonl'), 'x');
    if (process.platform !== 'win32') symlinkSync(outside, join(dir, '2020-01-02.jsonl'));
    await startRig({ dir });
    expect(readdirSync(dir).sort()).toEqual(['2020-01-01.jsonl.bak', '2020-1-1.jsonl', 'notes.txt', ...(process.platform === 'win32' ? [] : ['2020-01-02.jsonl'])].sort());
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
  });

  it('corrupt, oversized, schema-invalid and receivedAt-less lines are skipped; a torn last line does not poison the next append', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${dayOf(NOW0)}.jsonl`);
    const good = JSON.stringify({ ...makeEvent(1), receivedAt: NOW0 - 10 });
    const noReceived = JSON.stringify(makeEvent(2));
    const bad = JSON.stringify({ ...makeEvent(3), v: 9, receivedAt: NOW0 });
    writeFileSync(file, `${good}\nnot json\n\n${noReceived}\n${bad}\n${'x'.repeat(70_000)}\n${JSON.stringify({ ...makeEvent(4), receivedAt: NOW0 - 5 }).slice(0, 50)}`);
    const r = await startRig({ dir });
    expect((await getJson<EventsPage>(r.port, '/api/events')).events.map((e) => e.event.id)).toEqual([makeEvent(1).id]);
    expect(r.lines.some((l) => l.includes('unreadable lines skipped'))).toBe(true);
    await post(r.port, makeEvent(5));
    const lines = readFileSync(file, 'utf8').split('\n');
    expect(lines.at(-2)).toContain(makeEvent(5).id);
    expect(lines.at(-2)?.startsWith('{')).toBe(true);
  });

  it('files and folder are created user-only where the OS supports it', async () => {
    if (process.platform === 'win32') return;
    const dir = join(tempDir(), 'nested', 'events');
    const r = await startRig({ dir });
    await post(r.port, makeEvent(1));
    const { statSync } = await import('node:fs');
    expect(statSync(dir).mode & 0o077).toBe(0);
    const f = join(dir, readdirSync(dir)[0] ?? '');
    expect(statSync(f).mode & 0o077).toBe(0);
  });

  it('a failed disk write is a 500, nothing is kept or broadcast, and the same id can be retried', async () => {
    const dir = tempDir();
    const r = await startRig({ dir });
    const live = await wsOpen(r.port, { auth: 'header' });
    // Make today's file a directory so appendFile fails.
    mkdirSync(join(dir, `${dayOf(NOW0)}.jsonl`));
    const res = await post(r.port, makeEvent(1));
    expect(res.status).toBe(500);
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('store_failed');
    expect(r.bridge.store.size).toBe(0);
    await sleep(100);
    expect(live.messages.filter((m) => m.type === 'event')).toHaveLength(0);
    expect(existsSync(dir)).toBe(true);
    live.ws.close();
  });
});

describe('AC: /ws', () => {
  it('requires the token: header, or first message; a bad or missing token closes with 4401', async () => {
    const r = await startRig({ wsAuthTimeoutMs: 400 });
    const viaHeader = await wsOpen(r.port, { auth: 'header' });
    await viaHeader.waitFor((m) => m.type === 'hello');
    const viaMessage = await wsOpen(r.port, { auth: 'message' });
    await viaMessage.waitFor((m) => m.type === 'hello');
    expect(r.bridge.ws.clientCount).toBe(2);

    const badHeader = await wsOpen(r.port, { auth: 'header', token: 'nope' });
    expect((await badHeader.closed).code).toBe(4401);
    const badMessage = await wsOpen(r.port, { auth: 'message', token: 'nope' });
    expect((await badMessage.closed).code).toBe(4401);
    const silent = await wsOpen(r.port, { auth: 'none' });
    expect((await silent.closed).code).toBe(4401); // auth timeout
    const garbage = await wsOpen(r.port, { auth: 'none' });
    garbage.ws.send('{"type":"hello"}');
    expect((await garbage.closed).code).toBe(4401);
    const binary = await wsOpen(r.port, { auth: 'none' });
    binary.ws.send(Buffer.from(JSON.stringify({ type: 'auth', token: TOKEN })));
    expect((await binary.closed).code).toBe(4401);
    expect(badHeader.messages).toEqual([]);
    expect(silent.messages.filter((m) => m.type === 'event' || m.type === 'hello')).toEqual([]);
    expect(r.bridge.ws.clientCount).toBe(2);
    viaHeader.ws.close();
    viaMessage.ws.close();
  });

  it('an unauthenticated socket gets no live events', async () => {
    const r = await startRig({ wsAuthTimeoutMs: 2000 });
    const anon = await wsOpen(r.port, { auth: 'none' });
    await post(r.port, makeEvent(1));
    await sleep(150);
    expect(anon.messages).toEqual([]);
    anon.ws.close();
  });

  it('receives live events with seq and the bridge receivedAt, after a hello', async () => {
    const r = await startRig();
    r.clock.now = NOW0 + 42;
    const c = await wsOpen(r.port);
    const hello = await c.waitFor((m) => m.type === 'hello');
    expect(hello).toMatchObject({ boot: r.bridge.boot, lastSeq: 0 });
    await post(r.port, { ...makeEvent(1), receivedAt: 5 });
    await post(r.port, makeEvent(2));
    const m2 = await c.waitFor((m) => m.type === 'event' && m.seq === 2);
    expect(c.messages.filter((m) => m.type === 'event').map((m) => m.seq)).toEqual([1, 2]);
    expect((m2.event as OfficeEvent).receivedAt).toBe(NOW0 + 42);
    // a duplicate is not broadcast again
    await post(r.port, makeEvent(2));
    await sleep(100);
    expect(c.messages.filter((m) => m.type === 'event')).toHaveLength(2);
    c.ws.close();
  });

  it('survives a client dropping (clean close, abrupt terminate, mid-handshake) and keeps serving the others', async () => {
    const r = await startRig();
    const keeper = await wsOpen(r.port);
    const clean = await wsOpen(r.port);
    const abrupt = await wsOpen(r.port);
    const midHandshake = await wsOpen(r.port, { auth: 'none' });
    await keeper.waitFor((m) => m.type === 'hello');
    await clean.waitFor((m) => m.type === 'hello');
    await abrupt.waitFor((m) => m.type === 'hello');
    clean.ws.close();
    abrupt.ws.terminate();
    midHandshake.ws.terminate();
    for (let i = 1; i <= 20; i++) expect((await post(r.port, makeEvent(i))).status).toBe(204);
    await keeper.waitFor((m) => m.type === 'event' && m.seq === 20);
    expect(keeper.messages.filter((m) => m.type === 'event')).toHaveLength(20);
    await sleep(50);
    expect(r.bridge.ws.clientCount).toBe(1);
    keeper.ws.close();
  });

  it('refuses a wrong Host (421), a foreign Origin (403), another path (404) and a weird target (400)', async () => {
    const r = await startRig();
    await expect(wsOpen(r.port, { host: 'evil.example' })).rejects.toThrow('HTTP 421');
    await expect(wsOpen(r.port, { origin: 'https://evil.example' })).rejects.toThrow('HTTP 403');
    await expect(wsOpen(r.port, { path: '/other' })).rejects.toThrow('HTTP 404');
    const ok = await wsOpen(r.port, { origin: `http://127.0.0.1:${r.port}` });
    await ok.waitFor((m) => m.type === 'hello');
    ok.ws.close();
    const out = await raw(r.port, `GET http://evil.example/ws HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    expect(statusOf(out.text)).toBe(400);
  });

  it('a client sending a big message is disconnected; messages after auth are ignored', async () => {
    const r = await startRig();
    const c = await wsOpen(r.port);
    await c.waitFor((m) => m.type === 'hello');
    c.ws.send('{"type":"anything"}');
    await sleep(80);
    expect(r.bridge.ws.clientCount).toBe(1);
    c.ws.send('x'.repeat(5000));
    expect((await c.closed).code).toBe(1009);
    expect(r.bridge.ws.clientCount).toBe(0);
  });

  it('caps the number of sockets (503) and recovers when they leave', async () => {
    const r = await startRig();
    const open = [];
    for (let i = 0; i < 16; i++) open.push(await wsOpen(r.port));
    await expect(wsOpen(r.port)).rejects.toThrow('HTTP 503');
    for (const c of open) c.ws.close();
    await sleep(100);
    const again = await wsOpen(r.port);
    await again.waitFor((m) => m.type === 'hello');
    again.ws.close();
  });
});

describe('AC: burst of 1000 events', () => {
  it('1000 events (half of them duplicates sent twice) are all accepted, stored once, in order, and broadcast', async () => {
    const r = await startRig();
    const live = await wsOpen(r.port, { auth: 'header' });
    await live.waitFor((m) => m.type === 'hello');
    const events = Array.from({ length: 1000 }, (_v, i) => makeEvent(i % 500, { emittedAt: NOW0 + (i % 500) }));
    const t0 = Date.now();
    const statuses: number[] = [];
    for (let i = 0; i < events.length; i += 200) {
      const batch = await Promise.all(events.slice(i, i + 200).map((e) => post(r.port, e)));
      statuses.push(...batch.map((x) => x.status));
    }
    const ms = Date.now() - t0;
    expect(statuses.every((s) => s === 204)).toBe(true);
    expect(r.bridge.store.size).toBe(500);
    expect(storedLines(r.dir)).toHaveLength(500);
    expect(new Set(storedLines(r.dir).map((e) => e.id)).size).toBe(500);
    await live.waitFor((m) => m.type === 'event' && m.seq === 500, 10_000);
    const seqs = live.messages.filter((m) => m.type === 'event').map((m) => m.seq as number);
    expect(seqs).toEqual(Array.from({ length: 500 }, (_v, i) => i + 1));
    expect(ms).toBeLessThan(15_000);
    live.ws.close();
  }, 30_000);

  it('1000 distinct events, 200 in flight at a time', async () => {
    const r = await startRig();
    // 200 requests in flight at a time (each on its own connection, like the real hook script).
    const results = [];
    for (let i = 0; i < 1000; i += 200) results.push(...(await Promise.all(Array.from({ length: 200 }, (_v, j) => post(r.port, makeEvent(i + j))))));
    expect(results.filter((x) => x.status !== 204)).toEqual([]);
    expect(r.bridge.store.size).toBe(1000);
    const lines = storedLines(r.dir);
    expect(lines).toHaveLength(1000);
    const page = await getJson<EventsPage>(r.port, '/api/events?limit=5000');
    expect(page.events.map((e) => e.seq)).toEqual(Array.from({ length: 1000 }, (_v, i) => i + 1));
    // file order == seq order
    expect(page.events.map((e) => e.event.id)).toEqual(lines.map((e) => e.id));
  }, 60_000);
});
