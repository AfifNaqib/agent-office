// OfficeHub: the one SQLite-backed Durable Object (plan §9). It owns a HubCore
// over ctx.storage.sql, the daily retention alarm (FR-018) and, since V1-03, the
// UI WebSockets (hibernation API: the DO can sleep while sockets stay open; tags
// and the attachment survive). V1-04 adds the bridge socket here.
import { DurableObject } from 'cloudflare:workers';
import { runHubAlarm, scheduleHubAlarm } from './alarms.js';
import {
  BRIDGE_PATH,
  BRIDGE_TAG,
  CLOSE_BRIDGE_REPLACED,
  CLOSE_BRIDGE_STALE,
  bridgeFresh,
  bridgeLastSeen,
  bridgeStatusMessage,
  handleBridgeMessage,
  RejectLogThrottle,
  type BridgeAttachment,
} from './bridgeSockets.js';
import { HubCore, type EventsPage, type IngestResult, type SessionsPage, type StoredEvent } from './hubCore.js';
import { consoleLogger } from './log.js';
import type { SqlStore, SqlValue } from './sql.js';
import { errorBody, type RelayBindings } from './types.js';
import {
  CLOSE_REPLACED,
  PING_MESSAGE,
  PONG_MESSAGE,
  closeExpired,
  EXP_HEADER,
  UI_PATH,
  UI_TAG,
  canAdmit,
  eventMessage,
  fanout,
  helloMessage,
  loginExpired,
  onClientMessage,
  parseExp,
  safeClose,
  socketsToEvict,
  type UiAttachment,
} from './uiSockets.js';

function doSql(storage: DurableObjectStorage): SqlStore {
  return {
    exec: <T>(query: string, ...bindings: SqlValue[]) => storage.sql.exec(query, ...bindings).toArray() as T[],
    transaction: (fn) => storage.transactionSync(fn),
  };
}

const WS_OPEN = 1;

/** Same JSON error shape as the Worker routes (L-2); the Worker passes it through. */
function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify(errorBody(code, message)), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const ROUTE = 'ws-ui';

export class OfficeHub extends DurableObject<RelayBindings> {
  private core!: HubCore;
  private readonly bridgeLog = new RejectLogThrottle(consoleLogger);

  constructor(ctx: DurableObjectState, env: RelayBindings) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.core = new HubCore(doSql(ctx.storage), { onStored: (s) => { this.pushToUi(s); } });
      // N-1 keep-alive: answered by the runtime, the DO stays asleep.
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_MESSAGE, PONG_MESSAGE));
      await scheduleHubAlarm(ctx.storage, Date.now(), this.bridgeOnline(Date.now()));
    });
  }

  /** RPC from the Worker's /ingest route (event already validated and cleaned). */
  ingest(event: unknown): IngestResult {
    return this.core.ingest(event, 'ingest', Date.now());
  }

  sessions(): SessionsPage {
    return this.core.sessionList();
  }

  events(after: number, limit: number): EventsPage {
    return this.core.events(after, limit);
  }

  sessionEvents(key: string, after: number, limit: number): EventsPage | null {
    return this.core.sessionEvents(key, after, limit);
  }

  health(): { events7d: number; bridgeOnline: boolean } {
    const now = Date.now();
    return { events7d: this.core.events7d(now), bridgeOnline: this.bridgeOnline(now) };
  }

  /**
   * Only the Worker's /ws/ui route calls this, after the Access JWT and Origin checks;
   * the DO has no public URL. 101 + hibernating socket, hello first.
   */
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== UI_PATH && path !== BRIDGE_PATH) return jsonError(404, 'not_found', 'Not found');
    if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return jsonError(426, 'upgrade_required', 'WebSocket upgrade required');
    }
    if (path === BRIDGE_PATH) return this.acceptBridge();
    const now = Date.now();
    const expMs = parseExp(request.headers.get(EXP_HEADER));
    if (expMs === undefined || loginExpired(expMs, now)) {
      consoleLogger({ route: ROUTE, status: 401, kind: 'expired' });
      return jsonError(401, 'unauthorized', 'Missing or invalid Access login');
    }
    if (!canAdmit(this.openUiSockets().length)) {
      // N-1: dead sockets (phone asleep, network gone) must not lock the PO out.
      for (const ws of socketsToEvict(this.openUiSockets(), now)) {
        safeClose(ws, CLOSE_REPLACED, 'replaced');
        consoleLogger({ route: ROUTE, status: CLOSE_REPLACED, kind: 'evict' });
      }
      if (!canAdmit(this.openUiSockets().length)) {
        consoleLogger({ route: ROUTE, status: 503, kind: 'cap' });
        return jsonError(503, 'too_many_sockets', 'Too many open sockets');
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [UI_TAG]);
    const attachment: UiAttachment = { expMs, openedAt: now };
    server.serializeAttachment(attachment);
    server.send(helloMessage(this.core.boot, this.core.lastSeq(), this.bridgeOnline(now)));
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Only the Worker's /bridge route calls this, after the BRIDGE_TOKEN check. The
   * newest bridge wins: older bridge sockets are closed with 4000.
   */
  private async acceptBridge(): Promise<Response> {
    const now = Date.now();
    for (const old of this.ctx.getWebSockets(BRIDGE_TAG)) {
      safeClose(old, CLOSE_BRIDGE_REPLACED, 'replaced');
      consoleLogger({ route: 'bridge', status: CLOSE_BRIDGE_REPLACED, kind: 'replaced' });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [BRIDGE_TAG]);
    const attachment: BridgeAttachment = { openedAt: now };
    server.serializeAttachment(attachment);
    this.pushBridgeStatus(true);
    await scheduleHubAlarm(this.ctx.storage, now, true);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const now = Date.now();
    if (!this.isBridge(ws)) {
      onClientMessage(ws, message, now);
      return;
    }
    const out = handleBridgeMessage(message, (e) => this.core.ingest(e, 'bridge', now), now, () => this.core.chargeRate('bridge', now));
    if (out.log) this.bridgeLog.write(out.log, now);
    if (out.close) {
      safeClose(ws, out.close.code, out.close.reason);
      this.bridgeGone(ws);
      return;
    }
    if (out.reply === undefined) return;
    try {
      ws.send(out.reply);
    } catch {
      safeClose(ws, 1011, 'send failed');
      this.bridgeGone(ws);
    }
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    // Complete the close handshake (1005/1006 cannot be sent back).
    safeClose(ws, code === 1005 || code === 1006 ? 1000 : code, 'bye');
    if (this.isBridge(ws)) this.bridgeGone(ws);
  }

  override webSocketError(ws: WebSocket): void {
    safeClose(ws, 1011, 'error');
    if (this.isBridge(ws)) this.bridgeGone(ws);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    // Also drop UI sockets whose login expired while no events arrived.
    closeExpired(this.ctx.getWebSockets(UI_TAG), now);
    this.bridgeLog.flush(now);
    await runHubAlarm({
      core: this.core,
      storage: this.ctx.storage,
      now,
      log: consoleLogger,
      checkBridge: (t) => this.closeStaleBridges(t),
    });
  }

  private isBridge(ws: WebSocket): boolean {
    return this.ctx.getTags(ws).includes(BRIDGE_TAG);
  }

  private openBridgeSockets(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets(BRIDGE_TAG).filter((ws) => ws !== except && ws.readyState === WS_OPEN);
  }

  private lastSeen(ws: WebSocket): number {
    let attachment: unknown;
    try {
      attachment = ws.deserializeAttachment();
    } catch {
      attachment = undefined;
    }
    return bridgeLastSeen(attachment, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null);
  }

  /** An open bridge socket that answered a ping recently (GET /api/health, UI hello). */
  private bridgeOnline(now: number): boolean {
    return this.openBridgeSockets().some((ws) => bridgeFresh(this.lastSeen(ws), now));
  }

  /** Alarm check: closes bridge sockets that stopped answering pings; true if a live one is left. */
  private closeStaleBridges(now: number): boolean {
    let live = false;
    for (const ws of this.openBridgeSockets()) {
      if (bridgeFresh(this.lastSeen(ws), now)) {
        live = true;
        continue;
      }
      safeClose(ws, CLOSE_BRIDGE_STALE, 'no ping');
      consoleLogger({ route: 'bridge', status: CLOSE_BRIDGE_STALE, kind: 'stale' });
      this.bridgeGone(ws);
    }
    return live;
  }

  /** A bridge socket closed: tell the UI unless another bridge socket is still open. */
  private bridgeGone(ws: WebSocket): void {
    if (this.openBridgeSockets(ws).length === 0) this.pushBridgeStatus(false);
  }

  private pushBridgeStatus(online: boolean): void {
    const sockets = this.openUiSockets();
    if (sockets.length > 0) fanout(sockets, bridgeStatusMessage(online), Date.now());
  }

  private openUiSockets(): WebSocket[] {
    return this.ctx.getWebSockets(UI_TAG).filter((ws) => ws.readyState === WS_OPEN);
  }

  private pushToUi(stored: StoredEvent): void {
    const sockets = this.openUiSockets();
    if (sockets.length === 0) return;
    fanout(sockets, eventMessage(this.core.boot, stored), Date.now());
  }
}
