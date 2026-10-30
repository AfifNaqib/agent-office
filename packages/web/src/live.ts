// Live clients: history from /api/events, live events over a WebSocket, reconnect
// with backoff. Each event is delivered once, in server arrival order (seq). A new
// `boot` means the server's seq numbers restarted: the caller is told to reset,
// and history is loaded again from seq 0.
//
// Two servers speak the same messages (hello, then {type:'event', seq, boot, event}):
// - the PC bridge (V0-03, `connectLocal`): socket /ws, the local token in the first
//   message and in a header on history requests;
// - the relay (V1-05, `connectRelay`): socket /ws/ui, no token at all (the browser's
//   Cloudflare Access cookie goes with every same-origin request). It sends "ping"
//   every PING_MS and expects the runtime's "pong" within PONG_TIMEOUT_MS, else the
//   socket counts as dead: it is detached and closed, and the reconnect starts at once
//   (no wait for its onclose). Close 4000 = a newer tab took the slot
//   (no reconnect, so two tabs never keep evicting each other). Any other close is
//   checked with a login probe (GET /api/health, redirects not followed): a 401/403
//   or an Access redirect means the login expired, so the page asks to log in again.
//   The relay also says whether the PC bridge is connected (hello `bridgeOnline`, then
//   {type:'bridge', online} on every change, V1-04): handlers.onBridge.
import type { OfficeEvent } from '@agent-office/core';

export const TOKEN_HEADER = 'X-Agent-Office-Local';
/** Reconnect delays; the cap keeps a dropped socket back within 5 s (V0-03 AC). */
export const BACKOFF_MS = [500, 1_000, 2_000, 4_000] as const;
const PAGE = 5_000;
/** History pages loaded in one catch-up (about 2 million events); more means something is wrong, so give up and reconnect. */
export const MAX_CATCHUP_PAGES = 400;
/** Relay keep-alive (same strings as packages/relay/src/uiSockets.ts PING_MESSAGE / PONG_MESSAGE). */
export const PING_MESSAGE = 'ping';
export const PONG_MESSAGE = 'pong';
export const PING_MS = 30_000;
export const PONG_TIMEOUT_MS = 10_000;
/** Relay close codes (packages/relay/src/uiSockets.ts). */
export const CLOSE_REPLACED = 4000;
export const CLOSE_LOGIN_EXPIRED = 4401;

/** `login`: the relay login expired (reload to log in). `replaced`: a newer tab took this socket's slot. Both are final. */
export type LiveStatus = 'connecting' | 'live' | 'offline' | 'login' | 'replaced';

export interface LiveHandlers {
  onEvent(e: OfficeEvent): void;
  /** The server restarted its seq numbers: drop all state, history follows. */
  onReset(): void;
  onStatus(s: LiveStatus): void;
  /** Relay only (V1-04): the PC bridge connected to / left the relay (from hello, then {type:'bridge'}). */
  onBridge?(online: boolean): void;
}

export interface FetchInit {
  readonly headers: Record<string, string>;
  /** 'manual' for relay requests: an Access login redirect must not be followed (it is cross-origin). */
  readonly redirect?: 'manual';
}

export interface FetchResult {
  readonly ok: boolean;
  readonly status?: number;
  /** 'opaqueredirect' when a manual-redirect request was redirected. */
  readonly type?: string;
  json(): Promise<unknown>;
}

/** What the client needs from the browser, injectable for tests. */
export interface LiveDeps {
  readonly fetch: (url: string, init: FetchInit) => Promise<FetchResult>;
  readonly WebSocket: new (url: string) => MiniSocket;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
}

export interface MiniSocket {
  onopen: (() => void) | null;
  onmessage: ((m: { data: unknown }) => void) | null;
  onclose: ((ev?: { code?: number }) => void) | null;
  send(data: string): void;
  close(): void;
}

interface Page {
  boot: string;
  events: { seq: number; event: OfficeEvent }[];
  hasMore: boolean;
}

type WsMsg =
  | { type: 'hello'; boot: string; bridgeOnline?: unknown }
  | { type: 'event'; boot: string; seq: number; event: OfficeEvent }
  | { type: 'bridge'; online?: unknown; boot?: undefined };

interface Base {
  /** History origin ('' = same origin). */
  readonly http: string;
  /** WebSocket origin, e.g. `ws://127.0.0.1:47821` or `wss://<relay host>`. */
  readonly ws: string;
}

type Mode = { kind: 'bridge'; token: string } | { kind: 'relay' };

/** PC bridge client (V0-03). */
export function connectLocal(base: Base, token: string, h: LiveHandlers, deps: LiveDeps): { close(): void } {
  return connect(base, { kind: 'bridge', token }, h, deps);
}

/** Relay client (V1-05): same-origin, Access cookie, /ws/ui with ping/pong. */
export function connectRelay(base: Base, h: LiveHandlers, deps: LiveDeps): { close(): void } {
  return connect(base, { kind: 'relay' }, h, deps);
}

/** True when a relay response means "not logged in" (our 401/403, or an Access redirect to its login page). */
export function isLoginGone(res: FetchResult): boolean {
  return res.type === 'opaqueredirect' || res.status === 401 || res.status === 403;
}

function connect(base: Base, mode: Mode, h: LiveHandlers, deps: LiveDeps): { close(): void } {
  let boot: string | null = null;
  let lastSeq = 0;
  let attempt = 0;
  let closed = false;
  let socket: MiniSocket | null = null;
  // Live messages that arrive while history is loading wait here, so history is never skipped.
  let queue: { seq: number; event: OfficeEvent }[] | null = null;

  const relay = mode.kind === 'relay';
  const init: FetchInit = mode.kind === 'bridge' ? { headers: { [TOKEN_HEADER]: mode.token } } : { headers: {}, redirect: 'manual' };
  const wsPath = relay ? '/ws/ui' : '/ws';

  const deliver = (seq: number, event: OfficeEvent): void => {
    if (seq <= lastSeq) return;
    lastSeq = seq;
    h.onEvent(event);
  };

  const adoptBoot = (b: string): void => {
    if (boot !== null && b !== boot) {
      lastSeq = 0;
      h.onReset();
    }
    boot = b;
  };

  const stop = (s: LiveStatus): void => {
    closed = true;
    h.onStatus(s);
  };

  /** Loads history page by page. Stops when this socket is no longer current, and after MAX_CATCHUP_PAGES fetches (restarts included). */
  async function catchUp(ws: MiniSocket): Promise<void> {
    for (let pages = 0; ; pages++) {
      if (closed || socket !== ws) return;
      if (pages >= MAX_CATCHUP_PAGES) throw new Error('history did not end');
      const res = await deps.fetch(`${base.http}/api/events?after=${lastSeq}&limit=${PAGE}`, init);
      if (!res.ok) throw new Error('history request failed');
      const page = (await res.json()) as Page;
      if (page.boot !== boot) {
        adoptBoot(page.boot);
        continue; // restarted between hello and this page: start over from seq 0
      }
      for (const s of page.events) deliver(s.seq, s.event);
      if (!page.hasMore) return;
    }
  }

  function retry(): void {
    if (closed) return;
    h.onStatus('offline');
    const ms = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 4_000;
    attempt += 1;
    deps.setTimeout(open, ms);
  }

  /** Relay only: after a close, find out whether the login is gone (final) or the network/relay is (retry). */
  function probeThenRetry(): void {
    deps
      .fetch(`${base.http}/api/health`, init)
      .then((res) => {
        if (closed) return;
        if (isLoginGone(res)) stop('login');
        else retry();
      })
      .catch(() => {
        retry();
      });
  }

  /**
   * Relay only: gives up on a socket that looks dead (no pong, or send threw) without
   * waiting for its onclose, which a half-open connection may fire only minutes later
   * (or never). The socket is detached first, so a late onclose/onmessage from it does
   * nothing, then closed, then the login probe / reconnect runs right away.
   */
  function abandon(ws: MiniSocket): void {
    if (socket !== ws) return;
    socket = null;
    queue = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // already closing or closed: nothing to do
    }
    probeThenRetry();
  }

  /** Relay keep-alive: ping every PING_MS; no pong within PONG_TIMEOUT_MS abandons the socket and reconnects. */
  function keepAlive(ws: MiniSocket, state: { pongAt: number; pings: number }): void {
    deps.setTimeout(() => {
      if (closed || socket !== ws) return;
      const sent = ++state.pings;
      try {
        ws.send(PING_MESSAGE);
      } catch {
        abandon(ws);
        return;
      }
      deps.setTimeout(() => {
        if (closed || socket !== ws) return;
        if (state.pongAt < sent) abandon(ws);
        else keepAlive(ws, state);
      }, PONG_TIMEOUT_MS);
    }, PING_MS);
  }

  function open(): void {
    if (closed) return;
    h.onStatus('connecting');
    const ws = new deps.WebSocket(`${base.ws}${wsPath}`);
    socket = ws;
    queue = [];
    // pongAt = number of the last ping answered.
    const alive = { pongAt: 0, pings: 0 };
    ws.onopen = () => {
      if (socket !== ws) return;
      if (mode.kind === 'bridge') ws.send(JSON.stringify({ type: 'auth', token: mode.token }));
      else keepAlive(ws, alive);
    };
    ws.onmessage = (m) => {
      if (socket !== ws) return; // an abandoned or replaced socket
      const text = String(m.data);
      if (relay && text === PONG_MESSAGE) {
        alive.pongAt = alive.pings;
        return;
      }
      let msg: WsMsg;
      try {
        msg = JSON.parse(text) as WsMsg;
      } catch {
        return;
      }
      if (msg.type === 'bridge') {
        if (relay && typeof msg.online === 'boolean') h.onBridge?.(msg.online);
        return;
      }
      if (msg.type === 'hello') {
        if (relay && typeof msg.bridgeOnline === 'boolean') h.onBridge?.(msg.bridgeOnline);
        adoptBoot(msg.boot);
        catchUp(ws)
          .then(() => {
            if (socket !== ws) return; // this socket dropped meanwhile; its replacement catches up itself
            const waiting = queue ?? [];
            queue = null;
            for (const s of waiting) deliver(s.seq, s.event);
            attempt = 0;
            h.onStatus('live');
          })
          .catch(() => {
            ws.close();
          });
      } else if (msg.boot === boot) {
        if (queue) queue.push({ seq: msg.seq, event: msg.event });
        else deliver(msg.seq, msg.event);
      }
    };
    ws.onclose = (ev) => {
      if (socket !== ws) return;
      socket = null;
      if (!relay) {
        retry();
      } else if (ev?.code === CLOSE_REPLACED) {
        stop('replaced');
      } else {
        // 4401 (login expired), a failed upgrade (Access redirect shows up as 1006) or a network drop.
        probeThenRetry();
      }
    };
  }

  open();
  return {
    close: () => {
      closed = true;
      socket?.close();
    },
  };
}
