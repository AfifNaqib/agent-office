// V1-05: the web client against the relay (fake WebSocket, fetch and timers):
// /ws/ui with no token, history with redirect:'manual', "ping"/"pong" keep-alive,
// 4401 / Access redirect = "log in again", 4000 = replaced (no reconnect),
// backoff reconnect, boot change. Also the page mode and status line.
import { describe, expect, it } from 'vitest';
import type { OfficeEvent } from '@agent-office/core';
import {
  BACKOFF_MS,
  CLOSE_LOGIN_EXPIRED,
  CLOSE_REPLACED,
  PING_MESSAGE,
  PING_MS,
  PONG_MESSAGE,
  PONG_TIMEOUT_MS,
  connectRelay,
  isLoginGone,
  type FetchInit,
  type FetchResult,
  type LiveStatus,
  type MiniSocket,
} from '../src/live.js';
import { liveStatusText, pageMode } from '../src/mode.js';

const ev = (n: number): OfficeEvent => ({
  v: 1,
  id: `e${n}`,
  emittedAt: n,
  source: 'cloud',
  sessionId: 's1',
  actor: { kind: 'main', agentType: null, agentId: null },
  kind: 'notification',
  text: `n${n}`,
});

type Health = 'ok' | 401 | 403 | 'redirect' | 'throw';

/** A fake relay: stored events, a boot id, the sockets and requests the client made, pending timers. */
function fakeRelay() {
  const server = {
    boot: 'r1',
    stored: [] as { seq: number; event: OfficeEvent }[],
    sockets: [] as FakeSocket[],
    requests: [] as { url: string; init: FetchInit }[],
    health: 'ok' as Health,
    history: 'ok' as 'ok' | 401,
  };
  let timers: { fn: () => void; ms: number }[] = [];
  class FakeSocket implements MiniSocket {
    onopen: (() => void) | null = null;
    onmessage: ((m: { data: unknown }) => void) | null = null;
    onclose: ((ev?: { code?: number }) => void) | null = null;
    readonly sent: string[] = [];
    closedByClient = false;
    /** A half-open connection: close() fires no onclose (the browser may report it minutes later, or never). */
    silentClose = false;
    /** send() throws (socket already broken). */
    sendThrows = false;
    constructor(readonly url: string) {
      server.sockets.push(this);
    }
    send(data: string): void {
      if (this.sendThrows) throw new Error('InvalidStateError');
      this.sent.push(data);
    }
    close(): void {
      this.closedByClient = true;
      if (!this.silentClose) this.onclose?.({ code: 1005 });
    }
    hello(): void {
      this.onmessage?.({ data: JSON.stringify({ type: 'hello', boot: server.boot, lastSeq: server.stored.length }) });
    }
    push(seq: number, event: OfficeEvent): void {
      this.onmessage?.({ data: JSON.stringify({ type: 'event', boot: server.boot, seq, event }) });
    }
    pong(): void {
      this.onmessage?.({ data: PONG_MESSAGE });
    }
    serverClose(code: number): void {
      this.onclose?.({ code });
    }
  }
  const ok = (body: unknown): FetchResult => ({ ok: true, status: 200, type: 'basic', json: () => Promise.resolve(body) });
  const deps = {
    fetch: (url: string, init: FetchInit): Promise<FetchResult> => {
      server.requests.push({ url, init });
      if (url.includes('/api/health')) {
        const h = server.health;
        if (h === 'throw') return Promise.reject(new TypeError('network'));
        if (h === 'redirect') return Promise.resolve({ ok: false, status: 0, type: 'opaqueredirect', json: () => Promise.reject(new Error('opaque')) });
        if (h === 'ok') return Promise.resolve(ok({ ok: true }));
        return Promise.resolve({ ok: false, status: h, type: 'basic', json: () => Promise.resolve({}) });
      }
      if (server.history === 401) return Promise.resolve({ ok: false, status: 401, type: 'basic', json: () => Promise.resolve({}) });
      const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
      return Promise.resolve(ok({ boot: server.boot, events: server.stored.filter((s) => s.seq > after), hasMore: false }));
    },
    WebSocket: FakeSocket,
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  };
  const store = (n: number) => {
    const s = { seq: server.stored.length + 1, event: ev(n) };
    server.stored.push(s);
    return s;
  };
  /** Runs (and removes) the pending timers with this delay. */
  const fire = (ms: number): number => {
    const due = timers.filter((t) => t.ms === ms);
    timers = timers.filter((t) => t.ms !== ms);
    for (const t of due) t.fn();
    return due.length;
  };
  return { server, deps, store, fire, timers: () => timers };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function start(r: ReturnType<typeof fakeRelay>) {
  const got: string[] = [];
  const status: LiveStatus[] = [];
  const client = connectRelay({ http: '', ws: 'wss://relay.example' }, { onEvent: (e) => got.push(e.id), onReset: () => got.push('reset'), onStatus: (s) => status.push(s) }, r.deps);
  return { got, status, client };
}

async function goLive(r: ReturnType<typeof fakeRelay>, i = 0) {
  const ws = r.server.sockets[i];
  ws?.onopen?.();
  ws?.hello();
  await flush();
  return ws;
}

describe('connectRelay', () => {
  it('opens wss://<host>/ws/ui, sends no token, loads history with redirect:manual and no token header, then live', async () => {
    const r = fakeRelay();
    r.store(1);
    r.store(2);
    const c = start(r);
    const ws = await goLive(r);
    expect(ws?.url).toBe('wss://relay.example/ws/ui');
    expect(ws?.sent).toEqual([]);
    const hist = r.server.requests.find((q) => q.url.startsWith('/api/events'));
    expect(hist?.init).toEqual({ headers: {}, redirect: 'manual' });
    const s3 = r.store(3);
    ws?.push(s3.seq, s3.event);
    expect(c.got).toEqual(['e1', 'e2', 'e3']);
    expect(c.status).toEqual(['connecting', 'live']);
  });

  it(`sends "${PING_MESSAGE}" every ${PING_MS / 1000} s; a "${PONG_MESSAGE}" keeps the socket`, async () => {
    const r = fakeRelay();
    start(r);
    const ws = await goLive(r);
    for (let i = 1; i <= 3; i++) {
      expect(r.fire(PING_MS)).toBe(1);
      expect(ws?.sent).toEqual(Array.from({ length: i }, () => PING_MESSAGE));
      ws?.pong();
      expect(r.fire(PONG_TIMEOUT_MS)).toBe(1);
      expect(ws?.closedByClient).toBe(false);
    }
  });

  it(`no "${PONG_MESSAGE}" within ${PONG_TIMEOUT_MS / 1000} s: the socket is closed and reopened (login still good)`, async () => {
    const r = fakeRelay();
    r.store(1);
    const c = start(r);
    const ws = await goLive(r);
    r.fire(PING_MS);
    r.fire(PONG_TIMEOUT_MS);
    expect(ws?.closedByClient).toBe(true);
    await flush(); // login probe answers ok
    expect(r.server.requests.some((q) => q.url === '/api/health' && q.init.redirect === 'manual')).toBe(true);
    expect(c.status.at(-1)).toBe('offline');
    expect(r.fire(BACKOFF_MS[0])).toBe(1);
    expect(r.server.sockets).toHaveLength(2);
    const s2 = r.store(2);
    await goLive(r, 1);
    r.server.sockets[1]?.push(s2.seq, s2.event);
    expect(c.got).toEqual(['e1', 'e2']); // no duplicate of e1 after the reconnect
    expect(c.status.at(-1)).toBe('live');
  });

  it('L-2: no pong on a half-open socket (close() fires no onclose): detached, closed and the reconnect starts within the pong window', async () => {
    const r = fakeRelay();
    r.store(1);
    const c = start(r);
    const ws = await goLive(r);
    if (!ws) throw new Error('no socket');
    ws.silentClose = true;
    const lateClose = ws.onclose;
    const lateMessage = ws.onmessage;
    expect(r.fire(PING_MS)).toBe(1);
    const before = r.server.requests.length;
    expect(r.fire(PONG_TIMEOUT_MS)).toBe(1);
    expect(ws.closedByClient).toBe(true);
    // Detached: no handlers left on the old socket.
    expect(ws.onclose).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(ws.onopen).toBeNull();
    // The login probe ran at once, with no onclose event at all.
    expect(r.server.requests.slice(before).map((q) => q.url)).toEqual(['/api/health']);
    await flush();
    expect(c.status.at(-1)).toBe('offline');
    expect(r.fire(BACKOFF_MS[0])).toBe(1);
    expect(r.server.sockets).toHaveLength(2);
    await goLive(r, 1);
    expect(c.status.at(-1)).toBe('live');
    // A late onclose / message from the old socket (captured before it was detached) changes nothing.
    const requests = r.server.requests.length;
    const statuses = c.status.length;
    lateClose?.({ code: 1006 });
    lateMessage?.({ data: JSON.stringify({ type: 'event', boot: r.server.boot, seq: 9, event: ev(9) }) });
    await flush();
    expect(r.server.requests).toHaveLength(requests);
    expect(c.status).toHaveLength(statuses);
    expect(r.server.sockets).toHaveLength(2);
    expect(r.timers().filter((t) => t.ms !== PING_MS)).toEqual([]);
    expect(c.got).toEqual(['e1']);
  });

  it('L-2: ping send() throws: same immediate reconnect, no wait for onclose', async () => {
    const r = fakeRelay();
    const c = start(r);
    const ws = await goLive(r);
    if (!ws) throw new Error('no socket');
    ws.silentClose = true;
    ws.sendThrows = true;
    r.fire(PING_MS);
    expect(ws.closedByClient).toBe(true);
    expect(ws.onclose).toBeNull();
    expect(r.server.requests.at(-1)?.url).toBe('/api/health');
    await flush();
    expect(c.status.at(-1)).toBe('offline');
    expect(r.fire(BACKOFF_MS[0])).toBe(1);
    expect(r.server.sockets).toHaveLength(2);
  });

  it('L-2: no pong and the login is gone: status "login", no reconnect', async () => {
    const r = fakeRelay();
    const c = start(r);
    const ws = await goLive(r);
    if (!ws) throw new Error('no socket');
    ws.silentClose = true;
    r.server.health = 401;
    r.fire(PING_MS);
    r.fire(PONG_TIMEOUT_MS);
    await flush();
    expect(c.status.at(-1)).toBe('login');
    expect(r.timers()).toEqual([]);
    expect(r.server.sockets).toHaveLength(1);
  });

  it('a pong for an older ping does not count for a newer one', async () => {
    const r = fakeRelay();
    start(r);
    const ws = await goLive(r);
    r.fire(PING_MS);
    ws?.pong();
    r.fire(PONG_TIMEOUT_MS);
    r.fire(PING_MS); // second ping, never answered
    r.fire(PONG_TIMEOUT_MS);
    expect(ws?.closedByClient).toBe(true);
  });

  it.each<[Health, string]>([
    [401, 'our 401'],
    [403, 'our 403'],
    ['redirect', 'an Access login redirect'],
  ])('close %s after the login probe says %s: status "login", no reconnect', async (health) => {
    const r = fakeRelay();
    const c = start(r);
    const ws = await goLive(r);
    r.server.health = health;
    ws?.serverClose(CLOSE_LOGIN_EXPIRED);
    await flush();
    expect(c.status.at(-1)).toBe('login');
    expect(r.timers().filter((t) => BACKOFF_MS.includes(t.ms as (typeof BACKOFF_MS)[number]))).toEqual([]);
    expect(r.server.sockets).toHaveLength(1);
  });

  it('4401 but the login is still good (Access hands a fresh JWT): reconnects', async () => {
    const r = fakeRelay();
    const c = start(r);
    const ws = await goLive(r);
    ws?.serverClose(CLOSE_LOGIN_EXPIRED);
    await flush();
    expect(c.status.at(-1)).toBe('offline');
    r.fire(BACKOFF_MS[0]);
    expect(r.server.sockets).toHaveLength(2);
  });

  it('a failed upgrade (1006, e.g. Access redirect on the socket) runs the same login probe', async () => {
    const r = fakeRelay();
    const c = start(r);
    r.server.health = 'redirect';
    r.server.sockets[0]?.serverClose(1006);
    await flush();
    expect(c.status).toEqual(['connecting', 'login']);
  });

  it('the probe itself fails (network down): backoff reconnect, capped at 4 s', async () => {
    const r = fakeRelay();
    const c = start(r);
    r.server.health = 'throw';
    for (let i = 0; i < 6; i++) {
      r.server.sockets[i]?.serverClose(1006);
      await flush();
      const pending = r.timers().map((t) => t.ms);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toBe(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
      r.fire(pending[0] ?? 0);
    }
    expect(c.status.filter((s) => s === 'offline')).toHaveLength(6);
    expect(Math.max(...BACKOFF_MS)).toBeLessThanOrEqual(4_000);
  });

  it('4000 "replaced" (a newer tab took the slot): status "replaced", no probe, no reconnect', async () => {
    const r = fakeRelay();
    const c = start(r);
    const ws = await goLive(r);
    const before = r.server.requests.length;
    ws?.serverClose(CLOSE_REPLACED);
    await flush();
    expect(c.status.at(-1)).toBe('replaced');
    expect(r.server.requests.length).toBe(before);
    expect(r.timers().filter((t) => t.ms !== PING_MS)).toEqual([]);
    r.fire(PING_MS); // the old socket's keep-alive timer is a no-op now
    expect(ws?.sent).toEqual([]);
  });

  it('history answers 401 (login gone between socket and history): login state', async () => {
    const r = fakeRelay();
    const c = start(r);
    r.server.history = 401;
    r.server.health = 401;
    await goLive(r);
    expect(c.status.at(-1)).toBe('login');
  });

  it('a new boot resets and reloads from seq 0', async () => {
    const r = fakeRelay();
    r.store(1);
    const c = start(r);
    await goLive(r);
    r.server.sockets[0]?.serverClose(1006);
    await flush();
    r.server.boot = 'r2';
    r.server.stored = [];
    r.store(9);
    r.fire(BACKOFF_MS[0]);
    await goLive(r, 1);
    expect(c.got).toEqual(['e1', 'reset', 'e9']);
  });

  it('close() stops everything: no reconnect, no ping', async () => {
    const r = fakeRelay();
    const c = start(r);
    const ws = await goLive(r);
    c.client.close();
    await flush();
    r.fire(PING_MS);
    expect(ws?.sent).toEqual([]);
    expect(r.server.sockets).toHaveLength(1);
  });
});

describe('isLoginGone', () => {
  it('opaqueredirect, 401 and 403 mean the login is gone; 200, 404, 503 do not', () => {
    const res = (status: number, type = 'basic'): FetchResult => ({ ok: status === 200, status, type, json: () => Promise.resolve({}) });
    expect([res(0, 'opaqueredirect'), res(401), res(403)].map(isLoginGone)).toEqual([true, true, true]);
    expect([res(200), res(404), res(503)].map(isLoginGone)).toEqual([false, false, false]);
  });
});

describe('PC bridge status from the relay (V1-04)', () => {
  it('hello bridgeOnline, then {type:"bridge"} changes reach onBridge; events are unaffected', async () => {
    const r = fakeRelay();
    const seen: boolean[] = [];
    const got: string[] = [];
    connectRelay({ http: '', ws: 'wss://relay.example' }, { onEvent: (e) => got.push(e.id), onReset: () => undefined, onStatus: () => undefined, onBridge: (o) => seen.push(o) }, r.deps);
    const ws = r.server.sockets[0];
    ws?.onopen?.();
    ws?.onmessage?.({ data: JSON.stringify({ type: 'hello', boot: r.server.boot, lastSeq: 0, bridgeOnline: true }) });
    await flush();
    ws?.onmessage?.({ data: JSON.stringify({ type: 'bridge', online: false }) });
    ws?.onmessage?.({ data: JSON.stringify({ type: 'bridge', online: 'yes' }) }); // not a boolean: ignored
    ws?.onmessage?.({ data: JSON.stringify({ type: 'bridge', online: true }) });
    const s1 = r.store(1);
    ws?.push(s1.seq, s1.event);
    expect(seen).toEqual([true, false, true]);
    expect(got).toEqual(['e1']);
  });

  it('a hello without bridgeOnline (older relay) says nothing about the PC', async () => {
    const r = fakeRelay();
    const seen: boolean[] = [];
    connectRelay({ http: '', ws: 'wss://relay.example' }, { onEvent: () => undefined, onReset: () => undefined, onStatus: () => undefined, onBridge: (o) => seen.push(o) }, r.deps);
    await goLive(r);
    expect(seen).toEqual([]);
  });

  it('status line: "PC on" / "PC off" after "LIVE · relay"; unknown = nothing', () => {
    expect(liveStatusText('relay', 'live', 'x', true)).toBe('● LIVE · relay · PC on  x');
    expect(liveStatusText('relay', 'live', 'x', false)).toBe('● LIVE · relay · PC off  x');
    expect(liveStatusText('relay', 'live', 'x')).toBe('● LIVE · relay  x');
    expect(liveStatusText('bridge', 'live', 'x', true)).toBe('● LIVE  x');
  });
});

describe('pageMode / liveStatusText', () => {
  const doc = (metas: Record<string, string>) => ({
    querySelector: (sel: string) => {
      const name = /name="([^"]+)"/.exec(sel)?.[1] ?? '';
      const content = metas[name];
      return content === undefined ? null : { getAttribute: () => content };
    },
  });

  it('token meta = bridge (wins), mode meta "relay" = relay, nothing = demo', () => {
    expect(pageMode(doc({ 'agent-office-token': 'tok' }))).toEqual({ kind: 'bridge', token: 'tok' });
    expect(pageMode(doc({ 'agent-office-token': 'tok', 'agent-office-mode': 'relay' }))).toEqual({ kind: 'bridge', token: 'tok' });
    expect(pageMode(doc({ 'agent-office-mode': 'relay' }))).toEqual({ kind: 'relay' });
    expect(pageMode(doc({ 'agent-office-mode': 'other' }))).toEqual({ kind: 'demo' });
    expect(pageMode(doc({ 'agent-office-token': '' }))).toEqual({ kind: 'demo' });
    expect(pageMode(doc({}))).toEqual({ kind: 'demo' });
  });

  it('relay live = "● LIVE · relay"; bridge text unchanged', () => {
    expect(liveStatusText('relay', 'live', 'repo · Cloud · live')).toBe('● LIVE · relay  repo · Cloud · live');
    expect(liveStatusText('bridge', 'live', 'x')).toBe('● LIVE  x');
    expect(liveStatusText('bridge', 'offline', 'x')).toBe('○ bridge offline, retrying');
    expect(liveStatusText('relay', 'offline', 'x')).toBe('○ relay offline, retrying');
    expect(liveStatusText('relay', 'login', 'x')).toBe('○ login expired');
    expect(liveStatusText('relay', 'replaced', 'x')).toMatch(/newer tab/);
    expect(liveStatusText('relay', 'connecting', 'x')).toBe('○ connecting');
  });
});
