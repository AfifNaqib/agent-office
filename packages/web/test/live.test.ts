import { describe, expect, it } from 'vitest';
import type { OfficeEvent } from '@agent-office/core';
import { BACKOFF_MS, MAX_CATCHUP_PAGES, connectLocal, type LiveStatus, type MiniSocket } from '../src/live.js';

const ev = (n: number): OfficeEvent => ({
  v: 1,
  id: `e${n}`,
  emittedAt: n,
  source: 'local',
  sessionId: 's1',
  actor: { kind: 'main', agentType: null, agentId: null },
  kind: 'notification',
  text: `n${n}`,
});

/** A fake bridge: stored events, a boot id, and the sockets the client opened. */
function fakeBridge() {
  const server = { boot: 'b1', stored: [] as { seq: number; event: OfficeEvent }[], sockets: [] as FakeSocket[], tokens: [] as string[] };
  const timers: { fn: () => void; ms: number }[] = [];
  class FakeSocket implements MiniSocket {
    onopen: (() => void) | null = null;
    onmessage: ((m: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {
      server.sockets.push(this);
    }
    send(data: string): void {
      server.tokens.push((JSON.parse(data) as { token: string }).token);
    }
    close(): void {
      this.onclose?.();
    }
    hello(): void {
      this.onmessage?.({ data: JSON.stringify({ type: 'hello', boot: server.boot, lastSeq: server.stored.length }) });
    }
    push(seq: number, event: OfficeEvent): void {
      this.onmessage?.({ data: JSON.stringify({ type: 'event', boot: server.boot, seq, event }) });
    }
  }
  const deps = {
    fetch: (url: string) => {
      const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
      const events = server.stored.filter((s) => s.seq > after);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ boot: server.boot, events, hasMore: false }) });
    },
    WebSocket: FakeSocket,
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  };
  const store = (n: number) => {
    const s = { seq: server.stored.length + 1, event: ev(n) };
    server.stored.push(s);
    return s;
  };
  return { server, timers, deps, store };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('connectLocal', () => {
  it('loads history, then live events, and authenticates with the token message', async () => {
    const b = fakeBridge();
    b.store(1);
    b.store(2);
    const got: string[] = [];
    const status: LiveStatus[] = [];
    connectLocal({ http: '', ws: 'ws://x' }, 'tok', { onEvent: (e) => got.push(e.id), onReset: () => got.push('reset'), onStatus: (s) => status.push(s) }, b.deps);
    const ws = b.server.sockets[0];
    ws?.onopen?.();
    ws?.hello();
    await flush();
    const s3 = b.store(3);
    ws?.push(s3.seq, s3.event);
    expect(got).toEqual(['e1', 'e2', 'e3']);
    expect(b.server.tokens).toEqual(['tok']);
    expect(status.at(-1)).toBe('live');
  });

  it('a dropped socket reconnects within 5 s and catches up with no duplicates', async () => {
    const b = fakeBridge();
    b.store(1);
    const got: string[] = [];
    connectLocal({ http: '', ws: 'ws://x' }, 'tok', { onEvent: (e) => got.push(e.id), onReset: () => got.push('reset'), onStatus: () => undefined }, b.deps);
    b.server.sockets[0]?.hello();
    await flush();
    b.server.sockets[0]?.close();
    b.store(2); // missed while offline
    expect(b.timers.length).toBe(1);
    expect(b.timers[0]?.ms).toBeLessThanOrEqual(5_000);
    b.timers[0]?.fn();
    const ws2 = b.server.sockets[1];
    ws2?.hello();
    const s1 = b.server.stored[0];
    if (s1) ws2?.push(s1.seq, s1.event); // a redelivery must not duplicate
    await flush();
    expect(got).toEqual(['e1', 'e2']);
    expect(Math.max(...BACKOFF_MS)).toBeLessThanOrEqual(5_000);
  });

  it('live events arriving during history load are held, so history is not skipped', async () => {
    const b = fakeBridge();
    b.store(1);
    const got: string[] = [];
    connectLocal({ http: '', ws: 'ws://x' }, 'tok', { onEvent: (e) => got.push(e.id), onReset: () => undefined, onStatus: () => undefined }, b.deps);
    const ws = b.server.sockets[0];
    ws?.hello();
    const s2 = b.store(2);
    ws?.push(s2.seq, s2.event); // before the history fetch resolves
    await flush();
    expect(got).toEqual(['e1', 'e2']);
  });

  it('a bridge restart (new boot) resets and reloads from seq 0', async () => {
    const b = fakeBridge();
    b.store(1);
    const got: string[] = [];
    connectLocal({ http: '', ws: 'ws://x' }, 'tok', { onEvent: (e) => got.push(e.id), onReset: () => got.push('reset'), onStatus: () => undefined }, b.deps);
    b.server.sockets[0]?.hello();
    await flush();
    b.server.sockets[0]?.close();
    b.server.boot = 'b2';
    b.server.stored = [];
    b.store(7);
    b.timers[0]?.fn();
    b.server.sockets[1]?.hello();
    await flush();
    expect(got).toEqual(['e1', 'reset', 'e7']);
  });

  it('catch-up gives up after MAX_CATCHUP_PAGES pages and reconnects (a server that never ends the history)', async () => {
    const b = fakeBridge();
    let fetches = 0;
    const deps = {
      ...b.deps,
      fetch: () => {
        fetches += 1;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ boot: b.server.boot, events: [], hasMore: true }) });
      },
    };
    const status: LiveStatus[] = [];
    connectLocal({ http: '', ws: 'ws://x' }, 'tok', { onEvent: () => undefined, onReset: () => undefined, onStatus: (s) => status.push(s) }, deps);
    b.server.sockets[0]?.hello();
    for (let i = 0; i < MAX_CATCHUP_PAGES + 5; i++) await Promise.resolve();
    await flush();
    expect(fetches).toBe(MAX_CATCHUP_PAGES);
    expect(status.at(-1)).toBe('offline');
    expect(b.timers).toHaveLength(1);
  });

  it('catch-up stops fetching once its socket has dropped', async () => {
    const b = fakeBridge();
    let fetches = 0;
    const deps = {
      ...b.deps,
      fetch: () => {
        fetches += 1;
        b.server.sockets[0]?.close(); // the socket drops during the first page
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ boot: b.server.boot, events: [], hasMore: true }) });
      },
    };
    connectLocal({ http: '', ws: 'ws://x' }, 'tok', { onEvent: () => undefined, onReset: () => undefined, onStatus: () => undefined }, deps);
    b.server.sockets[0]?.hello();
    await flush();
    expect(fetches).toBe(1);
  });
});
