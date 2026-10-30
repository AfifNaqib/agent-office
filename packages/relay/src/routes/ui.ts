// UI routes behind the Access guard (V1-03, plan §10): the history API and the live
// socket. Same shapes as the PC bridge (packages/bridge/src/api.ts, ws.ts), so the
// web client talks to both the same way:
//   GET /api/sessions                          {boot, lastSeq, sessions}
//   GET /api/sessions/:key/events?after&limit  {boot, lastSeq, events:[{seq,event}], hasMore}
//   GET /api/events?after&limit                same, every session (catch-up after a dropped socket)
//   GET /ws/ui (WebSocket)                     hello, then {type:'event', seq, boot, event}
// The guard already checked the JWT (and, for the upgrade, the Origin).
import { isSessionKey, parsePaging } from '@agent-office/core';
import { Hono, type Context } from 'hono';
import type { HubApi, RelayBindings, RelayEnv } from '../types.js';
import { errorBody } from '../types.js';

export interface UiDeps<B extends RelayBindings> {
  readonly hub: (env: B) => HubApi;
}

export function uiRoutes<B extends RelayBindings>(deps: UiDeps<B>): Hono<RelayEnv<B>> {
  const app = new Hono<RelayEnv<B>>();
  const badQuery = (c: Context<RelayEnv<B>>): Response =>
    c.json(errorBody('bad_query', 'after and limit must be non-negative integers'), 400);

  app.get('/api/health', async (c) => {
    const { events7d, bridgeOnline } = await deps.hub(c.env).health();
    return c.json({ ok: true, bridgeOnline, events7d });
  });

  app.get('/api/sessions', async (c) => c.json(await deps.hub(c.env).sessions()));

  app.get('/api/sessions/:key/events', async (c) => {
    const paging = parsePaging(c.req.query('after'), c.req.query('limit'));
    if (!paging) return badQuery(c);
    const key = c.req.param('key');
    const page = isSessionKey(key) ? await deps.hub(c.env).sessionEvents(key, paging.after, paging.limit) : null;
    if (!page) return c.json(errorBody('not_found', 'Unknown session'), 404);
    return c.json(page);
  });

  app.get('/api/events', async (c) => {
    const paging = parsePaging(c.req.query('after'), c.req.query('limit'));
    if (!paging) return badQuery(c);
    return c.json(await deps.hub(c.env).events(paging.after, paging.limit));
  });

  app.get('/ws/ui', async (c) => {
    if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return c.json(errorBody('upgrade_required', 'WebSocket upgrade required'), 426);
    }
    const access = c.get('access');
    if (!access) return c.json(errorBody('unauthorized', 'Missing or invalid Access login'), 401);
    // Returned as is: no c.header() here, and securityHeaders skips a 101 (R-2).
    return deps.hub(c.env).connectUi(c.req.raw, access.expMs);
  });

  return app;
}
