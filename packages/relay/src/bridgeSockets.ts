// The PC bridge's socket (V1-04, plan §10 GET /bridge, FR-017, F3), free of Workers
// APIs so it is unit-tested with HubCore on node:sqlite. The OfficeHub DO (hub.ts)
// accepts the socket with the hibernation API (tag 'bridge') and calls these helpers.
//
// Only the Worker's /bridge route reaches the DO, after the BRIDGE_TOKEN check
// (routes/bridge.ts). One bridge at a time: a new one replaces (closes) the old.
//
// Bridge -> relay (text frames only):
//   "ping"                    keep-alive, answered "pong" by the runtime (no DO wake)
//   {type:'event', event}     one OfficeEvent, at most MAX_BRIDGE_MESSAGE_BYTES
// Relay -> bridge, one answer per event message:
//   {type:'ack', id}                     stored, or already stored (dedupe by id): drop it
//   {type:'reject', id, code}            invalid, never retry (id null if unreadable)
//   {type:'retry', id, retryAfterSec}    rate limited (plan §11: 1200/min): resend later
// L-2: every rejected frame also counts against the bridge bucket (1200/min, shared with
// events). A rejected frame over that limit closes the socket with 1008 instead of an
// answer, so a broken or hostile token holder cannot keep the DO busy parsing junk.
// Reject log lines are throttled to one per minute plus one summary line (RejectLogThrottle).
// The event goes through the same prepareEvent as POST /ingest, with source forced to
// 'local' (the channel decides, not the sender) and receivedAt from the relay clock.
import { MAX_EVENT_BYTES, type OfficeEvent } from '@agent-office/core';
import { utf8Length, type IngestResult } from './hubCore.js';
import { idPrefix, type LogFields, type Logger } from './log.js';
import { isPlainObject, knownKind, prepareEvent } from './prepare.js';
import { WINDOW_MS, type RateResult } from './ratelimit.js';

export const BRIDGE_PATH = '/bridge';
/** Hibernation tag of the bridge socket. */
export const BRIDGE_TAG = 'bridge';
/** One event (64 KB) plus the {type:'event', event:...} envelope. */
export const MAX_BRIDGE_MESSAGE_BYTES = MAX_EVENT_BYTES + 1024;
/** Close codes sent to the bridge. 4000 = a newer bridge took over (same as the UI's "replaced"). */
export const CLOSE_BRIDGE_REPLACED = 4000;
export const CLOSE_BRIDGE_STALE = 4408;
export const CLOSE_TOO_BIG = 1009;
export const CLOSE_UNSUPPORTED = 1003;
/** L-2: rejected frames over the bridge rate limit. */
export const CLOSE_POLICY = 1008;
/**
 * The bridge pings every 20 s (packages/bridge relayClient). A bridge whose last
 * answered ping (or, before the first one, its connect) is older than this counts as
 * gone: health says offline and the next check closes the socket.
 */
export const BRIDGE_STALE_MS = 60_000;
/** While a bridge is connected, the DO alarm comes back this often to check it. */
export const BRIDGE_CHECK_MS = 30_000;

export interface BridgeAttachment {
  readonly openedAt: number;
}

export type BridgeReply =
  | { readonly type: 'ack'; readonly id: string }
  | { readonly type: 'reject'; readonly id: string | null; readonly code: string }
  | { readonly type: 'retry'; readonly id: string; readonly retryAfterSec: number };

export interface BridgeOutcome {
  /** JSON text to send back, if any. */
  readonly reply?: string;
  /** Close the socket with this code (message too big, binary). */
  readonly close?: { readonly code: number; readonly reason: string };
  /** One log line (never the body). */
  readonly log?: LogFields;
}

const ROUTE = 'bridge';
/** Ids are echoed back only when they look like ids (the bridge matches its buffer by them). */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function reply(r: BridgeReply): string {
  return JSON.stringify(r);
}

/**
 * Handles one message from the bridge. `ingest` stores a prepared event (rate limit
 * bucket 'bridge', dedupe by id); a throw there becomes a 'retry' so nothing is lost.
 * `chargeReject` counts a rejected frame in the same bucket (L-2).
 */
export function handleBridgeMessage(
  message: string | ArrayBuffer,
  ingest: (e: OfficeEvent) => IngestResult,
  now: number,
  chargeReject: () => RateResult,
): BridgeOutcome {
  const rejected = (id: string | null, code: string, kind: string): BridgeOutcome => {
    let rate: RateResult;
    try {
      rate = chargeReject();
    } catch {
      rate = { ok: true };
    }
    if (!rate.ok) return { close: { code: CLOSE_POLICY, reason: 'too many invalid messages' }, log: { route: ROUTE, status: CLOSE_POLICY, kind: 'reject_flood' } };
    return { reply: reply({ type: 'reject', id, code }), log: { route: ROUTE, status: 400, kind } };
  };
  if (typeof message !== 'string') {
    return { close: { code: CLOSE_UNSUPPORTED, reason: 'text only' }, log: { route: ROUTE, status: 1003, kind: 'binary' } };
  }
  // UTF-16 length <= UTF-8 length, so the first test is a cheap early out.
  if (message.length > MAX_BRIDGE_MESSAGE_BYTES || utf8Length(message) > MAX_BRIDGE_MESSAGE_BYTES) {
    return { close: { code: CLOSE_TOO_BIG, reason: 'message too big' }, log: { route: ROUTE, status: 1009, kind: 'too_large' } };
  }
  let msg: unknown;
  try {
    msg = JSON.parse(message);
  } catch {
    return rejected(null, 'invalid_json', 'invalid_json');
  }
  if (!isPlainObject(msg) || msg.type !== 'event') {
    return rejected(null, 'unknown_type', 'unknown_type');
  }
  const raw = msg.event;
  const rawId = isPlainObject(raw) && typeof raw.id === 'string' && SAFE_ID.test(raw.id) ? raw.id : null;
  const prepared = prepareEvent(raw, 'local', now);
  if (!prepared.ok) {
    return rejected(rawId, prepared.code, prepared.kind === '-' ? knownKind(raw) : prepared.kind);
  }
  const event = prepared.event;
  // After cleaning the id can differ (a secret-looking id becomes 'redacted'); answer with the id the bridge sent.
  const answerId = rawId ?? event.id;
  let result: IngestResult;
  try {
    result = ingest(event);
  } catch {
    return { reply: reply({ type: 'retry', id: answerId, retryAfterSec: 5 }), log: { route: ROUTE, status: 500, kind: event.kind } };
  }
  switch (result.status) {
    case 'stored':
    case 'duplicate':
      return {
        reply: reply({ type: 'ack', id: answerId }),
        log: { route: ROUTE, status: result.status === 'stored' ? 204 : 'duplicate', kind: event.kind, id: idPrefix(event.id) },
      };
    case 'rate_limited':
      return { reply: reply({ type: 'retry', id: answerId, retryAfterSec: result.retryAfterSec }), log: { route: ROUTE, status: 429, kind: event.kind } };
    case 'invalid':
      return rejected(answerId, 'invalid_event', event.kind);
  }
}

/**
 * L-2: reject log lines (status 400 and the 1008 flood close) are throttled per minute
 * window: the first one is logged as is, the rest are counted, and when a later window
 * starts (next reject or `flush` from the DO alarm) one summary line gives the count.
 * Other lines pass straight through. In memory only: lost on hibernation (logs only).
 */
export class RejectLogThrottle {
  private windowStart = -Infinity;
  private logged = 0;
  private suppressed = 0;

  constructor(private readonly log: Logger) {}

  write(fields: LogFields, now: number): void {
    if (fields.status !== 400 && fields.status !== CLOSE_POLICY) {
      this.log(fields);
      return;
    }
    const start = now - (now % WINDOW_MS);
    if (start !== this.windowStart) {
      this.flush(now);
      this.windowStart = start;
      this.logged = 0;
    }
    if (this.logged === 0) {
      this.logged = 1;
      this.log(fields);
    } else {
      this.suppressed += 1;
    }
  }

  /** Writes the summary of a finished window (no-op inside the current one or with nothing suppressed). */
  flush(now: number): void {
    if (this.suppressed === 0 || now - (now % WINDOW_MS) === this.windowStart) return;
    this.log({ route: ROUTE, status: 'rejects_suppressed', kind: String(this.suppressed) });
    this.suppressed = 0;
  }
}

/** When the socket last showed life: its last answered ping, else when it was accepted. */
export function bridgeLastSeen(attachment: unknown, autoResponseAt: number | null): number {
  const openedAt =
    isPlainObject(attachment) && typeof attachment.openedAt === 'number' && Number.isFinite(attachment.openedAt) ? attachment.openedAt : -Infinity;
  return Math.max(openedAt, autoResponseAt ?? -Infinity);
}

export function bridgeFresh(lastSeen: number, now: number): boolean {
  return now - lastSeen < BRIDGE_STALE_MS;
}

/** Sent to UI sockets when the bridge connects or goes away (and in the UI hello). */
export function bridgeStatusMessage(online: boolean): string {
  return JSON.stringify({ type: 'bridge', online });
}

/**
 * The request the Worker forwards to the DO for a checked bridge upgrade: same URL,
 * no Authorization header (the DO never needs the token).
 */
export function bridgeUpgradeRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  return new Request(request.url, { method: 'GET', headers });
}
