// V1-04 against the real Workers runtime (`wrangler dev`, local workerd):
// - /bridge: BRIDGE_TOKEN (401), upgrade (426), no Origin (403), hibernating socket,
//   ack/reject answers, dedupe, source forced 'local', relay clock, "ping"/"pong";
// - the newest bridge replaces the old one (4000);
// - fan-out of bridge events to UI sockets, bridgeOnline in the UI hello, in
//   {type:'bridge'} messages and in /api/health;
// - integration: the REAL PC bridge (packages/bridge startBridge + relayClient) ->
//   a cuttable TCP proxy -> wrangler dev -> a UI socket. Plan AC: kill the relay link,
//   50 events buffered, reconnect, all 50 delivered once; the UI shows the bridge
//   offline/online within 10 s.
import { Socket, createServer, type Server } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OfficeEvent } from '@agent-office/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type ClientOptions } from 'ws';
import { startBridge, type Bridge } from '../../bridge/src/server.js';
import type { Logger } from '../../bridge/src/log.js';
import { AUD, BRIDGE_TOKEN, KID, TEAM, TEAM_KEY, TOKEN, accessJwt, makeEvent, publicJwk } from './helpers.js';
import { skipWorkerd, startWrangler, type Wrangler } from './workerdRig.js';

type Msg = Record<string, unknown> & { type: string };

interface Sock {
  readonly ws: WebSocket;
  readonly messages: Msg[];
  readonly closed: Promise<{ code: number; reason: string }>;
  next(pred: (m: Msg) => boolean, timeoutMs?: number): Promise<Msg>;
}

const H = 'cf-access-jwt-assertion';

function wrap(ws: WebSocket): Sock {
  const messages: Msg[] = [];
  const waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  ws.on('message', (data: Buffer) => {
    const text = data.toString();
    const m = text === 'pong' ? { type: 'pong' } : (JSON.parse(text) as Msg);
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
  return {
    ws,
    messages,
    closed,
    next: (pred, timeoutMs = 3000) => {
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
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`status ${res.statusCode ?? 0}`));
    });
    ws.once('error', reject);
  });
}

/** A TCP proxy that can be cut (all connections dropped, port closed) and restored on the same port. */
interface Link {
  readonly port: number;
  cut(): Promise<void>;
  restore(): Promise<void>;
  close(): Promise<void>;
}

async function cuttableLink(targetPort: number): Promise<Link> {
  const conns = new Set<Socket>();
  let server: Server | undefined;
  let port = 0;
  const listen = async (): Promise<void> => {
    const s = createServer((client) => {
      const upstream = new Socket();
      conns.add(client);
      conns.add(upstream);
      const drop = (): void => {
        client.destroy();
        upstream.destroy();
        conns.delete(client);
        conns.delete(upstream);
      };
      client.on('error', drop).on('close', drop);
      upstream.on('error', drop).on('close', drop);
      upstream.connect(targetPort, '127.0.0.1', () => {
        client.pipe(upstream).pipe(client);
      });
    });
    server = s;
    await new Promise<void>((resolve) => s.listen(port, '127.0.0.1', resolve));
    const addr = s.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  };
  const cut = async (): Promise<void> => {
    const s = server;
    server = undefined;
    for (const c of conns) c.destroy();
    conns.clear();
    if (s) {
      await new Promise<void>((resolve) => {
        s.close(() => {
          resolve();
        });
      });
    }
  };
  await listen();
  return {
    get port() {
      return port;
    },
    cut,
    restore: listen,
    close: cut,
  };
}

function postToBridge(port: number, token: string, e: OfficeEvent): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(e);
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/hooks/event', method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-office-local': token, host: `127.0.0.1:${port}` } },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** The PC bridge's local token in this test (built at run time). Never sent to the relay. */
const LOCAL_TOKEN = 'L'.repeat(21) + 'm3'.repeat(11);

describe.skipIf(skipWorkerd)('V1-04 on workerd: /bridge socket, fan-out, bridgeOnline, real bridge integration', () => {
  let w: Wrangler | undefined;
  let base = '';
  const socks: Sock[] = [];

  beforeAll(async () => {
    const jwks = JSON.stringify({ keys: [publicJwk(TEAM_KEY.publicKey, KID)] });
    w = await startWrangler(['--config', 'test/workerd/wrangler.jsonc'], {
      INGEST_TOKEN: TOKEN,
      BRIDGE_TOKEN,
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      TEST_ACCESS_JWKS: jwks,
    });
    base = w.base;
  }, 60_000);

  afterAll(async () => {
    for (const s of socks) s.ws.terminate();
    await w?.dispose();
  }, 15_000);

  const wsBase = (): string => base.replace('http', 'ws');
  // closeTimeout: see workerd-ws.test.ts (local workerd ends TCP late after a close frame).
  const opts = (headers: Record<string, string>): ClientOptions & { closeTimeout: number } => ({ headers, closeTimeout: 500 });

  async function ui(): Promise<Sock> {
    const ws = new WebSocket(`${wsBase()}/ws/ui`, opts({ [H]: await accessJwt({ now: Date.now() }), origin: base }));
    const s = wrap(ws);
    socks.push(s);
    await opened(ws);
    return s;
  }

  async function bridge(headers: Record<string, string> = { authorization: `Bearer ${BRIDGE_TOKEN}` }): Promise<Sock> {
    const ws = new WebSocket(`${wsBase()}/bridge`, opts(headers));
    const s = wrap(ws);
    socks.push(s);
    await opened(ws);
    return s;
  }

  const health = async (): Promise<{ ok: boolean; bridgeOnline: boolean; events7d: number }> =>
    (await (await fetch(`${base}/api/health`, { headers: { [H]: await accessJwt({ now: Date.now() }) } })).json()) as { ok: boolean; bridgeOnline: boolean; events7d: number };

  const sendEvent = (b: Sock, e: unknown): void => {
    b.ws.send(JSON.stringify({ type: 'event', event: e }));
  };

  it('refuses: no token / wrong token / the INGEST token (401), an Origin (403), a plain GET (426)', async () => {
    await expect(bridge({})).rejects.toThrow('status 401');
    await expect(bridge({ authorization: 'Bearer ' + 'x'.repeat(43) })).rejects.toThrow('status 401');
    await expect(bridge({ authorization: `Bearer ${TOKEN}` })).rejects.toThrow('status 401');
    await expect(bridge({ authorization: `Bearer ${BRIDGE_TOKEN}`, origin: base })).rejects.toThrow('status 403');
    const res = await fetch(`${base}/bridge`, { headers: { authorization: `Bearer ${BRIDGE_TOKEN}` } });
    expect(res.status).toBe(426);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect((await health()).bridgeOnline).toBe(false);
    expect(w?.output()).not.toContain(BRIDGE_TOKEN);
  });

  it('bridge socket: ack, dedupe, source local, relay clock, fan-out to UI within 1 s, bridgeOnline everywhere, ping/pong', async () => {
    const before = await ui();
    const hello0 = await before.next((m) => m.type === 'hello');
    expect(hello0.bridgeOnline).toBe(false);

    const b = await bridge();
    await before.next((m) => m.type === 'bridge' && m.online === true, 2000);
    expect((await health()).bridgeOnline).toBe(true);
    const u = await ui();
    expect((await u.next((m) => m.type === 'hello')).bridgeOnline).toBe(true);

    const e = makeEvent(1, { source: 'cloud', emittedAt: Date.now(), receivedAt: 1 } as never);
    const t0 = Date.now();
    sendEvent(b, e);
    expect(await b.next((m) => m.type === 'ack')).toEqual({ type: 'ack', id: e.id });
    const pushed = await u.next((m) => m.type === 'event', 1000);
    expect(Date.now() - t0).toBeLessThan(1500);
    const ev = pushed.event as OfficeEvent;
    expect(ev.id).toBe(e.id);
    expect(ev.source).toBe('local');
    expect(ev.receivedAt).toBeGreaterThanOrEqual(t0 - 1000);

    // Resent: acked again, not pushed again.
    sendEvent(b, e);
    await b.next((m) => m.type === 'ack' && b.messages.filter((x) => x.type === 'ack').length === 2);
    sendEvent(b, { ...makeEvent(2), kind: 'nope' });
    expect(await b.next((m) => m.type === 'reject')).toEqual({ type: 'reject', id: makeEvent(2).id, code: 'invalid_event' });
    b.ws.send('ping');
    await b.next((m) => m.type === 'pong', 1000);
    await new Promise((r) => setTimeout(r, 300));
    expect(u.messages.filter((m) => m.type === 'event')).toHaveLength(1);

    const sessions = (await (await fetch(`${base}/api/sessions`, { headers: { [H]: await accessJwt({ now: Date.now() }) } })).json()) as { sessions: { key: string }[] };
    expect(sessions.sessions.map((s) => s.key)).toContain(`local:${e.sessionId}`);

    // A message over the cap closes the bridge socket with 1009; the UI hears "offline".
    b.ws.send('x'.repeat(64 * 1024 + 2048));
    expect((await b.closed).code).toBe(1009);
    await u.next((m) => m.type === 'bridge' && m.online === false, 5000);
    expect((await health()).bridgeOnline).toBe(false);
    u.ws.close(1000);
    before.ws.close(1000);
  });

  it('the newest bridge replaces the old one (4000); the UI stays "online"; closing it says offline', async () => {
    const u = await ui();
    await u.next((m) => m.type === 'hello');
    const first = await bridge();
    await u.next((m) => m.type === 'bridge' && m.online === true);
    const second = await bridge();
    expect(await first.closed).toEqual({ code: 4000, reason: 'replaced' });
    await new Promise((r) => setTimeout(r, 300));
    expect(u.messages.filter((m) => m.type === 'bridge').map((m) => m.online)).not.toContain(false);
    expect((await health()).bridgeOnline).toBe(true);
    const t = Date.now();
    second.ws.close(1000);
    await u.next((m) => m.type === 'bridge' && m.online === false, 10_000);
    expect(Date.now() - t).toBeLessThan(10_000);
    u.ws.close(1000);
  });

  it('AC integration: real bridge -> cut link -> 50 events buffered -> link back -> all 50 reach the UI once', async () => {
    const wPort = Number(new URL(base).port);
    const link = await cuttableLink(wPort);
    const dir = mkdtempSync(join(tmpdir(), 'ao-v104-'));
    const lines: string[] = [];
    const logger: Logger = { event: (k, id, s) => lines.push(`event ${k} ${id.slice(0, 8)} ${s}`), info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`) };
    let pc: Bridge | undefined;
    try {
      const u = await ui();
      await u.next((m) => m.type === 'hello');
      pc = await startBridge({
        eventsDir: dir,
        token: LOCAL_TOKEN,
        port: 0,
        logger,
        relay: { url: `ws://127.0.0.1:${link.port}/bridge`, host: `127.0.0.1:${link.port}`, token: BRIDGE_TOKEN },
        relayTuning: { backoffMs: [200, 400, 800], pingMs: 1000, pongTimeoutMs: 1000 },
      });
      const tUp = Date.now();
      await u.next((m) => m.type === 'bridge' && m.online === true, 10_000);
      expect(Date.now() - tUp).toBeLessThan(10_000);

      await link.cut(); // "kill relay": the bridge loses the connection
      const tDown = Date.now();
      await u.next((m) => m.type === 'bridge' && m.online === false, 10_000);
      expect(Date.now() - tDown).toBeLessThan(10_000);
      await expect.poll(() => pc?.relay?.status(), { timeout: 5000 }).toBe('offline');

      const ids: string[] = [];
      const now = Date.now();
      for (let i = 0; i < 50; i += 1) {
        const e = makeEvent(1000 + i, { source: 'local', sessionId: 'pc-session-1', emittedAt: now + i });
        ids.push(e.id);
        expect(await postToBridge(pc.port, LOCAL_TOKEN, e)).toBe(204);
      }
      expect(pc.relay?.buffered).toBe(50);

      await link.restore();
      await expect.poll(() => u.messages.filter((m) => m.type === 'event').length, { timeout: 15_000 }).toBe(50);
      await expect.poll(() => pc?.relay?.buffered, { timeout: 5000 }).toBe(0);
      const got = u.messages.filter((m) => m.type === 'event').map((m) => (m.event as OfficeEvent).id);
      expect(new Set(got).size).toBe(50);
      expect([...got].sort()).toEqual([...ids].sort());
      expect(u.messages.filter((m) => m.type === 'event').every((m) => (m.event as OfficeEvent).source === 'local')).toBe(true);
      await u.next((m) => m.type === 'bridge' && m.online === true && u.messages.filter((x) => x.type === 'bridge' && x.online === true).length >= 2, 10_000);

      // Stopping the PC bridge: the UI hears offline within 10 s.
      const tStop = Date.now();
      await pc.stop();
      pc = undefined;
      await u.next((m) => m.type === 'bridge' && m.online === false && u.messages.filter((x) => x.type === 'bridge' && x.online === false).length >= 2, 10_000);
      expect(Date.now() - tStop).toBeLessThan(10_000);

      // Nothing secret in any log; the local token never reached the relay.
      const all = lines.join('\n') + (w?.output() ?? '');
      expect(all).not.toContain(BRIDGE_TOKEN);
      expect(all).not.toContain(LOCAL_TOKEN);
      expect(lines.some((l) => l.startsWith('info relay connected (50 buffered'))).toBe(true);
      u.ws.close(1000);
    } finally {
      await pc?.stop();
      await link.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
