// UI WebSocket fan-out (V1-03, plan §10 GET /ws/ui), free of Workers APIs so it is
// unit-tested with fake sockets. The OfficeHub DO (hub.ts) accepts the sockets with
// the hibernation API and calls these helpers.
//
// Messages to the client are the PC bridge's /ws messages, so packages/web/src/live.ts
// works against both: first {type:'hello', boot, lastSeq, bridgeOnline}, then one
// {type:'event', seq, boot, event} per newly stored event, in seq order, and
// {type:'bridge', online} whenever the PC bridge connects or goes away (V1-04).
// The relay needs no first-message auth: the Worker only forwards an upgrade that
// passed the Access JWT + Origin checks. Client messages are never interpreted (a
// {type:'auth'} from live.ts is ignored); one over 2 KB closes the socket.
//
// Keep-alive (N-1): the text message "ping" is answered "pong" by the runtime
// (DO setWebSocketAutoResponse) without waking the DO, so V1-05 can find dead
// sockets cheaply. The auto-response skips all JS, so it never checks the login;
// that is fine because no event data is sent after expiry (N-2, accepted).
import { CLOCK_TOLERANCE_SEC } from './auth/access.js';
import type { StoredEvent } from './hubCore.js';

export const UI_PATH = '/ws/ui';
/** Hibernation tag of UI sockets (the bridge socket has the tag 'bridge', bridgeSockets.ts). */
export const UI_TAG = 'ui';
/** Same caps as the PC bridge's /ws. */
export const MAX_UI_SOCKETS = 16;
export const MAX_CLIENT_MESSAGE_BYTES = 2048;
/** Close codes: login expired (client reconnects, Access gives a fresh JWT), message too big, send failed. */
export const CLOSE_LOGIN_EXPIRED = 4401;
export const CLOSE_TOO_BIG = 1009;
export const CLOSE_SEND_FAILED = 1011;
/** Closed to make room: the cap was hit and this was the oldest UI socket (N-1). */
export const CLOSE_REPLACED = 4000;
/** Keep-alive pair answered by the runtime (DO setWebSocketAutoResponse). */
export const PING_MESSAGE = 'ping';
export const PONG_MESSAGE = 'pong';
/**
 * A login counts as valid until exp + this, the same clock tolerance the Access
 * guard gives jose (L-2), so the HTTP API and the socket agree on "expired".
 */
export const EXP_GRACE_MS = CLOCK_TOLERANCE_SEC * 1000;
/**
 * Worker -> DO only: the Access JWT exp (ms) of the upgrade. The DO is not reachable
 * from the internet; the Worker always overwrites this header before forwarding.
 */
export const EXP_HEADER = 'x-agent-office-access-exp';

/** The parts of a hibernatable server WebSocket the fan-out uses. */
export interface UiSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  deserializeAttachment(): unknown;
}

export interface UiAttachment {
  /** Access JWT exp in ms; at or after exp + EXP_GRACE_MS the socket is closed with 4401. */
  readonly expMs: number;
  /** When the DO accepted the socket (ms); the oldest is evicted first at the cap. */
  readonly openedAt?: number;
}

/** Whether a login with this exp (ms) has expired at `now`, with the guard's tolerance. */
export function loginExpired(expMs: number | undefined, now: number): boolean {
  return expMs === undefined || now >= expMs + EXP_GRACE_MS;
}

/** A positive integer ms timestamp from EXP_HEADER, else undefined (DO answers 400). */
export function parseExp(value: string | null): number | undefined {
  if (value === null || !/^\d{1,16}$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function attachmentNumber(ws: UiSocket, field: 'expMs' | 'openedAt'): number | undefined {
  let a: unknown;
  try {
    a = ws.deserializeAttachment();
  } catch {
    return undefined;
  }
  if (typeof a !== 'object' || a === null) return undefined;
  const v = (a as Record<string, unknown>)[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function expOf(ws: UiSocket): number | undefined {
  return attachmentNumber(ws, 'expMs');
}

/** Closes without throwing (a socket that is already closing throws in workerd). */
export function safeClose(ws: UiSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // already closed
  }
}

/** Whether one more UI socket may join (open + not yet closed sockets counted by the caller). */
export function canAdmit(openSockets: number): boolean {
  return openSockets < MAX_UI_SOCKETS;
}

/**
 * N-1: which open sockets to close so one more can join. Sockets with an expired
 * (or unreadable) login go first, then the oldest by openedAt (a missing openedAt
 * counts as oldest), so dead sockets that never closed can never lock the PO out.
 * Returns [] while there is room.
 */
export function socketsToEvict<T extends UiSocket>(open: readonly T[], now: number): T[] {
  const excess = open.length - MAX_UI_SOCKETS + 1;
  if (excess <= 0) return [];
  const rank = (ws: T): [number, number] => [loginExpired(expOf(ws), now) ? 0 : 1, attachmentNumber(ws, 'openedAt') ?? -Infinity];
  return open
    .map((ws, i) => ({ ws, i, r: rank(ws) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i)
    .slice(0, excess)
    .map((x) => x.ws);
}

/** `bridgeOnline` (V1-04): whether the PC bridge is connected right now; later changes come as {type:'bridge', online}. */
export function helloMessage(boot: string, lastSeq: number, bridgeOnline = false): string {
  return JSON.stringify({ type: 'hello', boot, lastSeq, bridgeOnline });
}

export function eventMessage(boot: string, stored: StoredEvent): string {
  return JSON.stringify({ type: 'event', seq: stored.seq, boot, event: stored.event });
}

export interface FanoutResult {
  readonly sent: number;
  /** Sockets closed now: login expired, no valid attachment, or the send threw. */
  readonly closed: number;
}

/**
 * Sends one message to every socket whose login is still valid. A socket with an
 * expired (or missing) login is closed with 4401 instead; a socket whose send
 * throws is closed with 1011. One bad socket never stops the others.
 */
export function fanout(sockets: Iterable<UiSocket>, message: string, now: number): FanoutResult {
  let sent = 0;
  let closed = 0;
  for (const ws of sockets) {
    if (loginExpired(expOf(ws), now)) {
      safeClose(ws, CLOSE_LOGIN_EXPIRED, 'login expired');
      closed += 1;
      continue;
    }
    try {
      ws.send(message);
      sent += 1;
    } catch {
      safeClose(ws, CLOSE_SEND_FAILED, 'send failed');
      closed += 1;
    }
  }
  return { sent, closed };
}

/** Closes every socket whose login expired (run from the DO alarm, so idle sockets go too). */
export function closeExpired(sockets: Iterable<UiSocket>, now: number): number {
  let closed = 0;
  for (const ws of sockets) {
    if (loginExpired(expOf(ws), now)) {
      safeClose(ws, CLOSE_LOGIN_EXPIRED, 'login expired');
      closed += 1;
    }
  }
  return closed;
}

/**
 * The request the Worker forwards to the DO for a checked upgrade: same URL and
 * headers, with EXP_HEADER set from the verified JWT (any client copy overwritten).
 */
export function uiUpgradeRequest(request: Request, expMs: number): Request {
  const headers = new Headers(request.headers);
  headers.set(EXP_HEADER, String(Math.floor(expMs)));
  return new Request(request.url, { method: 'GET', headers });
}

function byteLength(message: string | ArrayBuffer): number {
  return typeof message === 'string' ? new TextEncoder().encode(message).length : message.byteLength;
}

/**
 * A message from a UI client. Never interpreted; over MAX_CLIENT_MESSAGE_BYTES the
 * socket is closed with 1009, and a socket whose login expired is closed with 4401.
 */
export function onClientMessage(ws: UiSocket, message: string | ArrayBuffer, now: number): void {
  if (byteLength(message) > MAX_CLIENT_MESSAGE_BYTES) {
    safeClose(ws, CLOSE_TOO_BIG, 'message too big');
    return;
  }
  if (loginExpired(expOf(ws), now)) safeClose(ws, CLOSE_LOGIN_EXPIRED, 'login expired');
}
