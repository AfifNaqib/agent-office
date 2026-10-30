// Relay forwarding (V1-04, plan §9 F3, FR-017): every new local event the bridge
// stores is sent to the relay's /bridge WebSocket, so the phone sees PC sessions too.
//
// - Outbound WSS only, no proxy (A3: the PC needs none), `Authorization: Bearer
//   <BRIDGE_TOKEN>` on the upgrade. The local token is never given to this module.
// - Every event stays in an in-memory buffer (at most MAX_BUFFER = 1000, oldest
//   dropped first) until the relay answers 'ack' (stored or duplicate) or 'reject'
//   (invalid, never retried). A reconnect resends everything not acked; the relay
//   dedupes by id, so each event is stored and shown once.
// - 'retry' (relay rate limit) pauses sending for the given seconds.
// - Keep-alive: "ping" every PING_MS (the relay runtime answers "pong" without waking
//   the Durable Object); no pong within PONG_TIMEOUT_MS = dead socket, reconnect.
// - Reconnect with backoff (BACKOFF_MS). Status lines go to the bridge log: never the
//   token, never event text; only counts, close codes and HTTP statuses.
// The buffer is memory only: events received while the relay is down are lost if the
// bridge itself is restarted before it reconnects (they stay in the local history).
import type { OfficeEvent } from '@agent-office/core';
import { WebSocket, type RawData } from 'ws';
import type { Logger } from './log.js';

export const MAX_BUFFER = 1000;
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** After the relay says another bridge took over (4000): wait long, so two bridges do not keep evicting each other. */
export const REPLACED_RETRY_MS = 60_000;
export const PING_MS = 20_000;
export const PONG_TIMEOUT_MS = 10_000;
export const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Relay answers are tiny; anything bigger is not from our relay. */
export const MAX_RELAY_MESSAGE_BYTES = 4096;
const CLOSE_REPLACED = 4000;
/** A failure reason is logged again only after this many retries with the same reason. */
const LOG_EVERY = 20;

export type RelayStatus = 'connected' | 'offline';

export interface RelayClientOptions {
  /** wss://<host>/bridge */
  readonly url: string;
  /** Relay host, for log lines. */
  readonly host: string;
  readonly token: string;
  readonly logger: Logger;
  readonly maxBuffer?: number;
  readonly backoffMs?: readonly number[];
  readonly replacedRetryMs?: number;
  readonly pingMs?: number;
  readonly pongTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly now?: () => number;
}

type RelayReply = { type: 'ack'; id: string } | { type: 'reject'; id: string | null; code: string } | { type: 'retry'; id: string; retryAfterSec: number };

function parseReply(text: string): RelayReply | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (r.type === 'ack' && typeof r.id === 'string') return { type: 'ack', id: r.id };
  if (r.type === 'reject' && (typeof r.id === 'string' || r.id === null)) return { type: 'reject', id: r.id, code: typeof r.code === 'string' ? r.code : '-' };
  if (r.type === 'retry' && typeof r.id === 'string' && typeof r.retryAfterSec === 'number' && Number.isFinite(r.retryAfterSec)) {
    return { type: 'retry', id: r.id, retryAfterSec: Math.min(Math.max(r.retryAfterSec, 1), 120) };
  }
  return undefined;
}

/** Only a status code or an error code, never a message (it could carry a header or URL). */
function failureReason(err: Error): string {
  const status = /Unexpected server response: (\d{3})/.exec(err.message)?.[1];
  if (status) return `HTTP ${status}`;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'error';
}

function hint(reason: string): string {
  if (reason === 'HTTP 401') return ' (BRIDGE_TOKEN in config.json does not match the relay secret)';
  if (reason === 'HTTP 503') return ' (the relay has no BRIDGE_TOKEN secret yet)';
  if (reason === 'HTTP 302' || reason === 'HTTP 403') return ' (Cloudflare Access did not let it through: check the bypass app lists /bridge)';
  return '';
}

export class RelayClient {
  private readonly pending = new Map<string, OfficeEvent>();
  /** Ids sent on the current socket and not answered yet. */
  private readonly inFlight = new Set<string>();
  private ws: WebSocket | null = null;
  private connected = false;
  private stopped = true;
  private attempt = 0;
  private pausedUntil = 0;
  private dropped = 0;
  private lastReason: string | null = null;
  private sameReason = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private resumeTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private readonly maxBuffer: number;
  private readonly now: () => number;

  constructor(private readonly opts: RelayClientOptions) {
    this.maxBuffer = opts.maxBuffer ?? MAX_BUFFER;
    this.now = opts.now ?? Date.now;
  }

  status(): RelayStatus {
    return this.connected ? 'connected' : 'offline';
  }

  /** Events waiting for the relay's answer (sent or not). */
  get buffered(): number {
    return this.pending.size;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.opts.logger.info(`relay forwarding on: ${this.opts.host}`);
    this.open();
  }

  /** Queues one stored local event; sends it now when connected. */
  push(event: OfficeEvent): void {
    if (event.source !== 'local' || this.pending.has(event.id)) return;
    while (this.pending.size >= this.maxBuffer) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
      this.inFlight.delete(oldest);
      if (this.dropped === 0) this.opts.logger.warn(`relay buffer full (${this.maxBuffer}): dropping the oldest events`);
      this.dropped += 1;
    }
    this.pending.set(event.id, event);
    this.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1_000);
      ws.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close(1000, 'bridge stopping');
    });
  }

  private open(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url, {
      headers: { authorization: `Bearer ${this.opts.token}` },
      handshakeTimeout: this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_RELAY_MESSAGE_BYTES,
      followRedirects: false,
      perMessageDeflate: false,
    });
    this.ws = ws;
    let reason = 'closed';
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.attempt = 0;
      this.lastReason = null;
      this.sameReason = 0;
      this.inFlight.clear();
      const lost = this.dropped > 0 ? `, ${this.dropped} dropped while offline` : '';
      this.dropped = 0;
      this.opts.logger.info(`relay connected (${this.pending.size} buffered${lost})`);
      this.keepAlive(ws);
      this.flush();
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (this.ws !== ws || isBinary) return;
      this.onMessage(ws, Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.concat(data as Buffer[]).toString('utf8'));
    });
    ws.on('error', (err: Error) => {
      reason = failureReason(err);
    });
    ws.on('close', (code: number) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasConnected = this.connected;
      this.connected = false;
      this.inFlight.clear();
      this.clearTimers();
      if (this.stopped) return;
      if (wasConnected || reason === 'closed') reason = `close ${code}`;
      this.scheduleReconnect(reason, code === CLOSE_REPLACED);
    });
  }

  private onMessage(ws: WebSocket, text: string): void {
    if (text === 'pong') {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      return;
    }
    const reply = parseReply(text);
    if (!reply) return;
    if (reply.type === 'ack') {
      this.pending.delete(reply.id);
      this.inFlight.delete(reply.id);
    } else if (reply.type === 'reject') {
      if (reply.id === null) return;
      const e = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      this.inFlight.delete(reply.id);
      if (e) this.opts.logger.event(e.kind, e.id, 'relay-reject');
    } else {
      this.inFlight.delete(reply.id);
      this.pause(ws, reply.retryAfterSec * 1000);
    }
  }

  private pause(ws: WebSocket, ms: number): void {
    const until = this.now() + ms;
    if (until <= this.pausedUntil) return;
    this.pausedUntil = until;
    this.opts.logger.warn(`relay rate limit: pausing ${Math.ceil(ms / 1000)} s`);
    this.resumeLater(ws, ms);
  }

  private resumeLater(ws: WebSocket, ms: number): void {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      if (this.ws === ws) this.flush();
    }, ms);
  }

  /** Sends every buffered event that is not already in flight on this socket, oldest first. */
  private flush(): void {
    const ws = this.ws;
    if (!this.connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    const wait = this.pausedUntil - this.now();
    if (wait > 0) {
      // Still rate limited (also after a reconnect, which cleared the timers).
      if (this.resumeTimer === undefined) this.resumeLater(ws, wait);
      return;
    }
    for (const [id, event] of this.pending) {
      if (this.inFlight.has(id)) continue;
      try {
        ws.send(JSON.stringify({ type: 'event', event }));
      } catch {
        ws.terminate();
        return;
      }
      this.inFlight.add(id);
    }
  }

  private keepAlive(ws: WebSocket): void {
    const pingMs = this.opts.pingMs ?? PING_MS;
    const pongTimeoutMs = this.opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws || this.pongTimer !== undefined) return;
      try {
        ws.send('ping');
      } catch {
        ws.terminate();
        return;
      }
      this.pongTimer = setTimeout(() => {
        if (this.ws !== ws) return;
        this.opts.logger.warn('relay did not answer the keep-alive: reconnecting');
        ws.terminate();
      }, pongTimeoutMs);
    }, pingMs);
  }

  private scheduleReconnect(reason: string, replaced: boolean): void {
    const backoff = this.opts.backoffMs ?? BACKOFF_MS;
    const ms = replaced ? (this.opts.replacedRetryMs ?? REPLACED_RETRY_MS) : (backoff[Math.min(this.attempt, backoff.length - 1)] ?? 30_000);
    this.attempt += 1;
    const label = replaced ? 'another bridge took over' : reason;
    if (label !== this.lastReason || ++this.sameReason >= LOG_EVERY) {
      this.lastReason = label;
      this.sameReason = 0;
      this.opts.logger.warn(`relay offline (${label}${hint(label)}), retry in ${Math.ceil(ms / 1000)} s, ${this.pending.size} buffered`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.open();
    }, ms);
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.resumeTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.reconnectTimer = undefined;
    this.resumeTimer = undefined;
    this.pingTimer = undefined;
    this.pongTimer = undefined;
  }
}
