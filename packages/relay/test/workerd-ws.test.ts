// V1-03 against the real Workers runtime (`wrangler dev`, local workerd): the UI
// socket /ws/ui through the Access guard (R-2: the 101 must survive the
// securityHeaders middleware), hibernation accept + hello, fan-out of an ingested
// event to two sockets within 1 s (plan V1-03 AC), the history API, the socket cap,
// the client message cap and login expiry.
//
// The JWT is real RS256, signed with the test key; the TEST ONLY entry
// (test/workerd/entry.ts) checks it against TEST_ACCESS_JWKS instead of the team
// certs. The production entry is covered by workerd.test.ts.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OfficeEvent } from '@agent-office/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type ClientOptions } from 'ws';
import { CLOSE_REPLACED, MAX_UI_SOCKETS, PING_MESSAGE, PONG_MESSAGE } from '../src/uiSockets.js';
import { AUD, KID, TEAM, TEAM_KEY, TOKEN, accessJwt, makeEvent, publicJwk } from './helpers.js';
import { relayDir, skipWorkerd, startWrangler, type Wrangler } from './workerdRig.js';

const webAssets = join(relayDir, '..', 'web', 'dist', 'assets');

type Msg =
  | { type: 'hello'; boot: string; lastSeq: number }
  | { type: 'event'; seq: number; boot: string; event: OfficeEvent }
  /** The runtime's keep-alive answer (plain text "pong", not JSON). */
  | { type: 'pong' };

interface Client {
  readonly ws: WebSocket;
  readonly messages: Msg[];
  /** Resolves with the next message matching `pred` (already received ones count). */
  next(pred: (m: Msg) => boolean, timeoutMs?: number): Promise<Msg>;
  closed: Promise<{ code: number; reason: string }>;
}

const H = 'cf-access-jwt-assertion';

describe.skipIf(skipWorkerd)('V1-03 on workerd: /ws/ui fan-out + history', () => {
  let w: Wrangler | undefined;
  let base = '';
  const clients: Client[] = [];

  beforeAll(async () => {
    const jwks = JSON.stringify({ keys: [publicJwk(TEAM_KEY.publicKey, KID)] });
    w = await startWrangler(['--config', 'test/workerd/wrangler.jsonc'], {
      INGEST_TOKEN: TOKEN,
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      TEST_ACCESS_JWKS: jwks,
    });
    base = w.base;
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) c.ws.terminate();
    await w?.dispose();
  }, 15_000);

  const jwt = (expOffset = 3600): Promise<string> => accessJwt({ now: Date.now(), expOffset });

  async function open(opts: { jwt?: string | null; origin?: string | null } = {}): Promise<Client> {
    const headers: Record<string, string> = {};
    const token = opts.jwt === undefined ? await jwt() : opts.jwt;
    if (token !== null) headers[H] = token;
    const origin = opts.origin === undefined ? base : opts.origin;
    if (origin !== null) headers.origin = origin;
    // closeTimeout: 'close' fires soon after the close FRAME. Local workerd ends the TCP
    // connection only ~10 s after a close sent from inside an RPC (fan-out path);
    // the frame itself (with its code) arrives at once.
    // closeTimeout exists in ws 8.22 but not in @types/ws yet.
    const options: ClientOptions & { closeTimeout: number } = { headers, closeTimeout: 500 };
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/ui`, options);
    const messages: Msg[] = [];
    const waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
    ws.on('message', (data: Buffer) => {
      const text = data.toString();
      const m = text === PONG_MESSAGE ? ({ type: 'pong' } as const) : (JSON.parse(text) as Msg);
      messages.push(m);
      for (const wt of [...waiters]) {
        if (wt.pred(m)) {
          waiters.splice(waiters.indexOf(wt), 1);
          wt.resolve(m);
        }
      }
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    const c: Client = {
      ws,
      messages,
      closed,
      next: (pred, timeoutMs = 2000) => {
        const have = messages.find(pred);
        if (have) return Promise.resolve(have);
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            reject(new Error('no matching message'));
          }, timeoutMs);
          waiters.push({
            pred,
            resolve: (m) => {
              clearTimeout(t);
              resolve(m);
            },
          });
        });
      },
    };
    clients.push(c);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve();
      });
      ws.once('unexpected-response', (_req, res) => {
        reject(new Error(`status ${res.statusCode ?? 0}`));
      });
      ws.once('error', reject);
    });
    return c;
  }

  const post = (e: unknown): Promise<Response> =>
    fetch(`${base}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(e) });
  const api = async (path: string): Promise<Response> => fetch(`${base}${path}`, { headers: { [H]: await jwt() } });

  it('R-2 + AC: two sockets upgrade through the guard, get hello, and each receive an ingested event within 1 s', async () => {
    const a = await open();
    const b = await open();
    const helloA = await a.next((m) => m.type === 'hello');
    const helloB = await b.next((m) => m.type === 'hello');
    if (helloA.type !== 'hello' || helloB.type !== 'hello') throw new Error('no hello');
    expect(helloA.boot).toMatch(/^[0-9a-f-]{36}$/);
    expect(helloB.boot).toBe(helloA.boot);
    expect(helloA.lastSeq).toBe(0);

    const e = makeEvent(1, { emittedAt: Date.now() });
    const t0 = Date.now();
    expect((await post(e)).status).toBe(204);
    const [ma, mb] = await Promise.all([a.next((m) => m.type === 'event', 1000), b.next((m) => m.type === 'event', 1000)]);
    expect(Date.now() - t0).toBeLessThan(1000 + 500); // POST round trip + push
    for (const m of [ma, mb]) {
      if (m.type !== 'event') throw new Error('not an event');
      expect(m.seq).toBe(1);
      expect(m.boot).toBe(helloA.boot);
      expect(m.event.id).toBe(e.id);
      expect(m.event.source).toBe('cloud');
      expect(typeof m.event.receivedAt).toBe('number');
    }
    // A duplicate is stored once and never pushed again.
    expect((await post(e)).status).toBe(204);
    expect((await post(makeEvent(2, { emittedAt: Date.now() }))).status).toBe(204);
    const second = await a.next((m) => m.type === 'event' && m.seq === 2, 1000);
    expect(second.type === 'event' && second.event.id).toBe(makeEvent(2).id);
    expect(a.messages.flatMap((m) => (m.type === 'event' ? [m.seq] : []))).toEqual([1, 2]);

    // A client message under the cap (live.ts sends {type:'auth'}) is ignored; the socket stays.
    a.ws.send(JSON.stringify({ type: 'auth', token: 'ignored' }));
    expect((await post(makeEvent(3, { emittedAt: Date.now() }))).status).toBe(204);
    await a.next((m) => m.type === 'event' && m.seq === 3, 1000);
    a.ws.close(1000);
    b.ws.close(1000);
    await Promise.all([a.closed, b.closed]);
  });

  it('history API mirrors the bridge: /api/events paging, /api/sessions, /api/sessions/:key/events', async () => {
    const all = (await (await api('/api/events?after=0&limit=2')).json()) as { boot: string; lastSeq: number; events: { seq: number; event: OfficeEvent }[]; hasMore: boolean };
    expect(all.lastSeq).toBe(3);
    expect(all.events.map((s) => s.seq)).toEqual([1, 2]);
    expect(all.hasMore).toBe(true);
    const rest = (await (await api('/api/events?after=2')).json()) as typeof all;
    expect(rest.events.map((s) => s.seq)).toEqual([3]);
    expect(rest.hasMore).toBe(false);
    expect(rest.boot).toBe(all.boot);

    const sessions = (await (await api('/api/sessions')).json()) as { boot: string; sessions: { key: string; eventCount: number; lastSeq: number }[] };
    const key = `cloud:${makeEvent(1).sessionId}`;
    expect(sessions.sessions).toEqual([expect.objectContaining({ key, eventCount: 3, lastSeq: 3 })]);
    const one = (await (await api(`/api/sessions/${key}/events?after=1`)).json()) as typeof all;
    expect(one.events.map((s) => s.seq)).toEqual([2, 3]);
    expect((await api('/api/sessions/cloud:nope/events')).status).toBe(404);
    expect((await api('/api/events?after=-1')).status).toBe(400);
    expect(await (await api('/api/health')).json()).toEqual({ ok: true, bridgeOnline: false, events7d: 3 });
    // History needs the JWT too.
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
  });

  it('no JWT -> 401, wrong or missing Origin -> 403, plain GET -> 426: no socket', async () => {
    await expect(open({ jwt: null })).rejects.toThrow('status 401');
    await expect(open({ origin: 'https://evil.example' })).rejects.toThrow('status 403');
    await expect(open({ origin: null })).rejects.toThrow('status 403');
    const res = await api('/ws/ui');
    expect(res.status).toBe(426);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('a client message over 2 KB closes the socket with 1009', async () => {
    const c = await open();
    c.ws.send('x'.repeat(2049));
    expect((await c.closed).code).toBe(1009);
  });

  // L-2: the DO allows the same 30 s clock tolerance as the guard. A JWT whose exp is
  // 27 s in the past still passes the guard and the DO, and the socket is closed
  // once exp + 30 s has passed (~3 s later).
  it('a socket whose Access JWT expired is closed with 4401 on the next event (and on its next message)', async () => {
    const [c, d] = await Promise.all([open({ jwt: await jwt(-27) }), open({ jwt: await jwt(-27) })]);
    const live = await open();
    await Promise.all([c, d, live].map((x) => x.next((m) => m.type === 'hello')));
    await new Promise((r) => setTimeout(r, 3500));
    const t = Date.now();
    expect((await post(makeEvent(4, { emittedAt: Date.now() }))).status).toBe(204);
    expect((await c.closed).code).toBe(4401);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(c.messages.some((m) => m.type === 'event')).toBe(false);
    // The socket with a valid login still got the event.
    await live.next((m) => m.type === 'event' && m.seq === 4, 1000);
    // d: closed by the fan-out too; the message path is checked with a fresh expired socket below.
    expect((await d.closed).code).toBe(4401);
    const e = await open({ jwt: await jwt(-27) });
    await e.next((m) => m.type === 'hello');
    await new Promise((r) => setTimeout(r, 3500));
    e.ws.send('hi');
    expect((await e.closed).code).toBe(4401);
    live.ws.close(1000);
  }, 20_000);

  it('L-2: 10 to 20 s past exp, HTTP and the socket agree: both still accept (guard tolerance = DO grace)', async () => {
    for (const offset of [-10, -20]) {
      const token = await jwt(offset);
      const res = await fetch(`${base}/api/events?after=0&limit=1`, { headers: { [H]: token } });
      expect(res.status).toBe(200);
      const c = await open({ jwt: token });
      const hello = await c.next((m) => m.type === 'hello');
      if (hello.type !== 'hello') throw new Error('no hello');
      c.ws.send('hi'); // the message path keeps it open too
      const seq = hello.lastSeq + 1;
      expect((await post(makeEvent(100 + offset, { emittedAt: Date.now() }))).status).toBe(204);
      await c.next((m) => m.type === 'event' && m.seq === seq, 1000);
      c.ws.close(1000);
      await c.closed;
    }
    // Past the tolerance both refuse: the guard answers 401 JSON before the DO.
    const old = await jwt(-40);
    const res = await fetch(`${base}/api/events`, { headers: { [H]: old } });
    expect(res.status).toBe(401);
    await expect(open({ jwt: old })).rejects.toThrow('status 401');
  }, 20_000);

  it('N-1: "ping" is answered "pong" by the runtime; the socket stays usable', async () => {
    const c = await open();
    const hello = await c.next((m) => m.type === 'hello');
    if (hello.type !== 'hello') throw new Error('no hello');
    c.ws.send(PING_MESSAGE);
    await c.next((m) => m.type === 'pong', 1000);
    expect((await post(makeEvent(200, { emittedAt: Date.now() }))).status).toBe(204);
    await c.next((m) => m.type === 'event' && m.seq === hello.lastSeq + 1, 1000);
    c.ws.close(1000);
    await c.closed;
  });

  it(`N-1: at most ${MAX_UI_SOCKETS} UI sockets; one more evicts the oldest (4000 "replaced"), never refused`, async () => {
    const oldest = await open();
    await oldest.next((m) => m.type === 'hello');
    await new Promise((r) => setTimeout(r, 20));
    const rest = await Promise.all(Array.from({ length: MAX_UI_SOCKETS - 1 }, () => open()));
    await Promise.all(rest.map((c) => c.next((m) => m.type === 'hello')));
    const newer = await open();
    await newer.next((m) => m.type === 'hello');
    const closed = await oldest.closed;
    expect(closed).toEqual({ code: CLOSE_REPLACED, reason: 'replaced' });
    // The others stay open and still get events.
    expect(rest.every((c) => c.ws.readyState === WebSocket.OPEN)).toBe(true);
    expect((await post(makeEvent(300, { emittedAt: Date.now() }))).status).toBe(204);
    await Promise.all([...rest, newer].map((c) => c.next((m) => m.type === 'event' && m.event.id === makeEvent(300).id, 1000)));
    await expect.poll(() => w?.output() ?? '', { timeout: 3000 }).toContain('"kind":"evict"');
    expect(w?.output()).toContain('"route":"ws-ui"');
    for (const c of [...rest, newer]) c.ws.close(1000);
  }, 20_000);

  it('V1-05: the real assets binding (run_worker_first) serves the web build only with a JWT, with the CSP', async () => {
    const js = readdirSync(webAssets).find((f) => f.endsWith('.js'));
    expect(js).toBeDefined();
    for (const p of ['/', `/assets/${js}`, '/index.html']) {
      const res = await fetch(`${base}${p}`, { redirect: 'manual' });
      expect(res.status, p).toBe(401);
      expect(await res.text()).not.toContain('<html');
    }
    const token = await jwt();
    const page = await fetch(`${base}/`, { headers: { [H]: token } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<meta name="agent-office-mode" content="relay" /></head>');
    expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/);
    expect(html).not.toMatch(/<style|style=/);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const asset = await fetch(`${base}/assets/${js}`, { headers: { [H]: token } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect(asset.headers.get('content-security-policy')).toContain("style-src 'self'");
    // L-1: hashed build files are immutable for a year; the page stays no-store.
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('cache-control')).toBe('no-store');
    // Paths the binding would answer on its own (html_handling) stay ours.
    expect((await fetch(`${base}/index.html`, { headers: { [H]: token }, redirect: 'manual' })).status).toBe(404);
  });
});
