// The bridge HTTP server (plan §9 to §11). Binds 127.0.0.1 only. One Hono app for
// /hooks/event and /api/*, one WebSocket hub for /ws, one JSONL store.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { apiRoutes } from './api.js';
import { hooksRoutes } from './hooks.js';
import { silentLogger, type Logger } from './log.js';
import type { RelayConfig } from './config.js';
import { RelayClient, type RelayClientOptions } from './relayClient.js';
import { deny, guard, type BridgeEnv } from './security.js';
import { EventStore } from './store.js';
import { uiRoutes } from './ui.js';
import { WsHub } from './ws.js';

/** The listening address is fixed (plan §11, MUST NOT 2). Only the port is configurable. */
export const BRIDGE_HOST = '127.0.0.1';
/** Slowloris limits: headers within 10 s, the whole request within 15 s. */
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_HEADER_BYTES = 8 * 1024;
/** Hooks open one short connection each; a few hundred in flight is already far beyond one PC. */
export const MAX_CONNECTIONS = 256;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface BridgeOptions {
  readonly eventsDir: string;
  readonly token: string;
  /** 0 = any free port. */
  readonly port: number;
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly retentionMs?: number;
  readonly cleanupIntervalMs?: number;
  readonly headersTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly wsAuthTimeoutMs?: number;
  /** Built web app to serve at / (packages/web/dist). Unset = no UI routes. */
  readonly webDir?: string;
  /** Forward local events to the relay (V1-04). Unset = local only. */
  readonly relay?: RelayConfig | undefined;
  /** Test knobs for the relay client (timings, buffer size). */
  readonly relayTuning?: Partial<Omit<RelayClientOptions, 'url' | 'host' | 'token' | 'logger'>>;
}

export interface Bridge {
  readonly port: number;
  readonly host: string;
  readonly boot: string;
  readonly store: EventStore;
  readonly server: Server;
  readonly ws: WsHub;
  /** Null when relay forwarding is off. */
  readonly relay: RelayClient | null;
  stop(): Promise<void>;
}

export function buildApp(deps: {
  getPort: () => number;
  getToken: () => string;
  store: EventStore;
  hub: () => WsHub;
  boot: string;
  now: () => number;
  logger: Logger;
  webDir?: string;
  relay?: RelayClient | null;
}): Hono<BridgeEnv> {
  const app = new Hono<BridgeEnv>();
  app.use('*', guard(deps.getPort));
  app.route(
    '/',
    hooksRoutes({
      store: deps.store,
      getToken: deps.getToken,
      now: deps.now,
      logger: deps.logger,
      onStored: (s) => {
        deps.hub().broadcast(s);
        deps.relay?.push(s.event);
      },
    }),
  );
  app.route('/', apiRoutes({ store: deps.store, getToken: deps.getToken, boot: deps.boot, relay: () => deps.relay?.status() ?? 'offline' }));
  if (deps.webDir !== undefined) app.route('/', uiRoutes({ webDir: deps.webDir, getToken: deps.getToken }));
  app.notFound((c) => deny(c, 404, 'not_found', 'Not found'));
  app.onError((_err, c) => deny(c, 500, 'internal', 'Internal error'));
  return app;
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? silentLogger;
  const boot = randomBytes(8).toString('hex');
  const store = await EventStore.open({ dir: opts.eventsDir, now, logger, ...(opts.retentionMs === undefined ? {} : { retentionMs: opts.retentionMs }) });

  let port = opts.port;
  const hub = new WsHub({
    getPort: () => port,
    getToken: () => opts.token,
    boot,
    getLastSeq: () => store.lastSeq,
    logger,
    ...(opts.wsAuthTimeoutMs === undefined ? {} : { authTimeoutMs: opts.wsAuthTimeoutMs }),
  });
  const relay = opts.relay ? new RelayClient({ ...opts.relayTuning, url: opts.relay.url, host: opts.relay.host, token: opts.relay.token, logger }) : null;
  const app = buildApp({
    relay,
    getPort: () => port,
    getToken: () => opts.token,
    store,
    hub: () => hub,
    boot,
    now,
    logger,
    ...(opts.webDir === undefined ? {} : { webDir: opts.webDir }),
  });

  const listener = getRequestListener(app.fetch);
  const server = createServer(
    {
      maxHeaderSize: MAX_HEADER_BYTES,
      headersTimeout: opts.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
      requestTimeout: opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      keepAliveTimeout: 5_000,
      connectionsCheckingInterval: 1_000,
    },
    (req, res) => {
      void listener(req, res);
    },
  );
  server.maxConnections = MAX_CONNECTIONS;
  hub.attach(server);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, BRIDGE_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  relay?.start();

  const timer = setInterval(() => {
    void store.cleanup().catch(() => {
      logger.warn('cleanup failed');
    });
  }, opts.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS);
  timer.unref();

  return {
    port,
    host: BRIDGE_HOST,
    boot,
    store,
    server,
    ws: hub,
    relay,
    stop: async () => {
      clearInterval(timer);
      await relay?.stop();
      hub.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      await store.flush();
    },
  };
}

