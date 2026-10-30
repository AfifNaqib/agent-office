// The relay's HTTP app (Hono). Routes: POST /ingest (Access bypass, INGEST_TOKEN) and
// the UI routes (Access): /api/health, history and /ws/ui (V1-03, routes/ui.ts), and
// the office web app itself: / and /assets/* (V1-05, routes/assets.ts).
// V1-02: every path except the bypass paths needs a valid Access JWT (auth/guard.ts),
// state-changing requests and WS upgrades need our own Origin, every response except
// a 101 carries CSP + security headers. V1-04: GET /bridge (Access bypass, BRIDGE_TOKEN, routes/bridge.ts). No CORS headers on any response (plan §10).
import { Hono } from 'hono';
import { remoteKeys, type KeySource } from './auth/access.js';
import { accessGuard, rawPath, securityHeaders } from './auth/guard.js';
import { consoleLogger, type Logger } from './log.js';
import { assetRoutes } from './routes/assets.js';
import { bridgeRoutes } from './routes/bridge.js';
import { ingestRoutes } from './routes/ingest.js';
import { uiRoutes } from './routes/ui.js';
import { errorBody, type HubApi, type RelayBindings, type RelayEnv } from './types.js';

export interface RelayDeps<B extends RelayBindings> {
  readonly hub: (env: B) => HubApi;
  readonly now?: () => number;
  readonly log?: Logger;
  /** Access signing keys. Default: the team JWKS (cached). Tests pass a local key set. */
  readonly accessKeys?: KeySource;
}

export function createApp<B extends RelayBindings>(deps: RelayDeps<B>): Hono<RelayEnv<B>> {
  const log = deps.log ?? consoleLogger;
  const now = deps.now ?? (() => Date.now());
  // Route on the raw pathname (no percent-decoding), the same one the guard checks.
  const app = new Hono<RelayEnv<B>>({ getPath: rawPath });

  app.use('*', securityHeaders<B>());
  app.use('*', accessGuard<B>({ keys: deps.accessKeys ?? remoteKeys, now, log }));

  app.route('/', uiRoutes({ hub: deps.hub }));
  app.route('/', assetRoutes<B>());
  app.route('/', ingestRoutes({ hub: deps.hub, now, log }));
  app.all('/ingest', (c) => {
    c.header('Allow', 'POST');
    return c.json(errorBody('method_not_allowed', 'Use POST'), 405);
  });
  app.route('/', bridgeRoutes({ hub: deps.hub, log }));
  app.all('/bridge', (c) => {
    c.header('Allow', 'GET');
    return c.json(errorBody('method_not_allowed', 'Use a GET WebSocket upgrade'), 405);
  });

  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));
  app.onError((err, c) => {
    log({ route: 'error', status: 500, kind: err.name });
    return c.json(errorBody('internal', 'Internal error'), 500);
  });
  return app;
}
