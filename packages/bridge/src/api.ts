// Read-only history API (plan §10): /api/sessions, /api/sessions/:key/events?after=seq,
// plus /api/events?after=seq for catch-up across sessions after a dropped socket.
// `boot` changes on every bridge start: a client that sees a new value must reload,
// because seq numbers restart.
import { Hono } from 'hono';
import { isSessionKey, parsePaging } from '@agent-office/core';
import { deny, requireToken, type BridgeEnv } from './security.js';
import type { EventStore } from './store.js';

export { DEFAULT_PAGE, MAX_PAGE } from '@agent-office/core';

export interface ApiDeps {
  readonly store: EventStore;
  readonly getToken: () => string;
  readonly boot: string;
  readonly relay: () => 'connected' | 'offline';
}

export function apiRoutes(deps: ApiDeps): Hono<BridgeEnv> {
  const app = new Hono<BridgeEnv>();

  // Loopback only and Host-checked by the guard; no token, so the UI can show "bridge offline" cheaply.
  app.get('/api/health', (c) => c.json({ ok: true, relay: deps.relay(), boot: deps.boot, events: deps.store.size }));

  app.use('/api/sessions', requireToken(deps.getToken));
  app.use('/api/sessions/*', requireToken(deps.getToken));
  app.use('/api/events', requireToken(deps.getToken));

  app.get('/api/sessions', (c) => c.json({ boot: deps.boot, lastSeq: deps.store.lastSeq, sessions: deps.store.sessions() }));

  app.get('/api/sessions/:key/events', (c) => {
    const key = c.req.param('key');
    const paging = parsePaging(c.req.query('after'), c.req.query('limit'));
    if (!paging) return deny(c, 400, 'bad_query', 'after and limit must be non-negative integers');
    if (!isSessionKey(key) || !deps.store.hasSession(key)) return deny(c, 404, 'not_found', 'Unknown session');
    const { events, hasMore } = deps.store.sessionEvents(key, paging.after, paging.limit);
    return c.json({ boot: deps.boot, lastSeq: deps.store.lastSeq, events, hasMore });
  });

  app.get('/api/events', (c) => {
    const paging = parsePaging(c.req.query('after'), c.req.query('limit'));
    if (!paging) return deny(c, 400, 'bad_query', 'after and limit must be non-negative integers');
    const { events, hasMore } = deps.store.allEvents(paging.after, paging.limit);
    return c.json({ boot: deps.boot, lastSeq: deps.store.lastSeq, events, hasMore });
  });

  return app;
}
