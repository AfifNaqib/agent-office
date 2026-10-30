// /ws: live fan-out of stored events to the local UI (plan §10). The token arrives
// either in the X-Agent-Office-Local upgrade header or, for browsers (which cannot
// set headers on a WebSocket), in the first message {"type":"auth","token":"..."}
// within AUTH_TIMEOUT_MS; otherwise the socket closes with 4401. Messages from the
// client are never interpreted after that. A broken or slow client is dropped
// without affecting the others.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Logger } from './log.js';
import { hostAllowed, hostHeaderCount, requestTargetOk, tokensEqual, LOCAL_TOKEN_HEADER } from './security.js';
import type { StoredEvent } from './store.js';

export const WS_PATH = '/ws';
export const AUTH_TIMEOUT_MS = 5_000;
export const CLOSE_UNAUTHORIZED = 4401;
export const MAX_CLIENT_MESSAGE_BYTES = 2048;
export const MAX_SOCKETS = 16;
/** A client that lets this much pile up is dropped. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
const PING_INTERVAL_MS = 30_000;

export interface WsDeps {
  readonly getPort: () => number;
  readonly getToken: () => string;
  readonly boot: string;
  readonly getLastSeq: () => number;
  readonly logger: Logger;
  readonly authTimeoutMs?: number;
}

function reject(socket: Duplex, status: string): void {
  if (socket.writable) socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // non-browser client
  const o = origin.toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  private readonly authed = new Set<WebSocket>();
  private readonly all = new Set<WebSocket>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: WsDeps) {}

  get clientCount(): number {
    return this.authed.size;
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.onUpgrade(req, socket, head);
    });
    this.timer = setInterval(() => {
      this.heartbeat();
    }, PING_INTERVAL_MS);
    this.timer.unref();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined);
    const port = this.deps.getPort();
    const refusal = this.refusal(req, port);
    if (refusal !== undefined) {
      reject(socket, refusal);
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, req);
    });
  }

  /** Why this upgrade must be refused (status line), or undefined to accept. */
  private refusal(req: IncomingMessage, port: number): string | undefined {
    if (!requestTargetOk(req.url)) return '400 Bad Request';
    if (hostHeaderCount(req) !== 1 || !hostAllowed(req.headers.host, port)) return '421 Misdirected Request';
    if (pathOf(req.url ?? '') !== WS_PATH) return '404 Not Found';
    if (!originAllowed(req.headers.origin, port)) return '403 Forbidden';
    if (this.all.size >= MAX_SOCKETS) return '503 Service Unavailable';
    return undefined;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    this.all.add(ws);
    this.alive.set(ws, true);
    ws.on('error', () => {
      ws.terminate();
    });
    ws.on('close', () => {
      this.all.delete(ws);
      this.authed.delete(ws);
    });
    ws.on('pong', () => {
      this.alive.set(ws, true);
    });

    const headerToken = req.headers[LOCAL_TOKEN_HEADER.toLowerCase()];
    if (typeof headerToken === 'string') {
      if (tokensEqual(headerToken, this.deps.getToken())) this.accept(ws);
      else ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    const timer = setTimeout(() => {
      if (!this.authed.has(ws)) ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
    }, this.deps.authTimeoutMs ?? AUTH_TIMEOUT_MS);
    ws.once('close', () => {
      clearTimeout(timer);
    });
    ws.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(timer);
      const token = isBinary ? undefined : firstMessageToken(data);
      if (token !== undefined && tokensEqual(token, this.deps.getToken())) this.accept(ws);
      else ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
    });
  }

  private accept(ws: WebSocket): void {
    this.authed.add(ws);
    // After auth the client's messages are ignored (the default 'message' listener list is empty).
    ws.on('message', () => undefined);
    this.send(ws, JSON.stringify({ type: 'hello', boot: this.deps.boot, lastSeq: this.deps.getLastSeq() }));
  }

  private send(ws: WebSocket, text: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.deps.logger.warn('dropping a slow websocket client');
      ws.terminate();
      return;
    }
    try {
      ws.send(text, (err) => {
        if (err) ws.terminate();
      });
    } catch {
      ws.terminate();
    }
  }

  broadcast(stored: StoredEvent): void {
    if (this.authed.size === 0) return;
    const text = JSON.stringify({ type: 'event', seq: stored.seq, boot: this.deps.boot, event: stored.event });
    for (const ws of this.authed) this.send(ws, text);
  }

  private heartbeat(): void {
    for (const ws of this.all) {
      if (this.alive.get(ws) !== true) {
        ws.terminate();
        continue;
      }
      this.alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const ws of this.all) ws.terminate();
    this.wss.close();
  }
}

function firstMessageToken(data: RawData): string | undefined {
  try {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
    const msg = JSON.parse(text) as unknown;
    if (typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'auth') {
      const t = (msg as { token?: unknown }).token;
      return typeof t === 'string' ? t : undefined;
    }
  } catch {
    // not JSON
  }
  return undefined;
}
