// GET /bridge (plan §10, FR-017, V1-04): the PC bridge's WebSocket. Access bypass
// path (guard.ts BYPASS_PATHS), so the token is the only gate.
// Order: BRIDGE_TOKEN configured (503) -> Bearer BRIDGE_TOKEN, constant time (401) ->
// WebSocket upgrade (426) -> no Origin header at all, empty included (403: the bridge is a Node client and
// sends none; a browser always does) -> the DO takes the socket (101), closing any
// older bridge socket. Logged as route + status + kind only, never a header value.
import { Hono, type Context } from 'hono';
import { bearerMatches, tokenConfigured } from '../auth/tokens.js';
import type { Logger } from '../log.js';
import type { HubApi, RelayBindings, RelayEnv } from '../types.js';
import { errorBody } from '../types.js';

const ROUTE = 'bridge';

export interface BridgeRouteDeps<B extends RelayBindings> {
  readonly hub: (env: B) => HubApi;
  readonly log: Logger;
}

type Status = 401 | 403 | 426 | 500 | 503;

export function bridgeRoutes<B extends RelayBindings>(deps: BridgeRouteDeps<B>): Hono<RelayEnv<B>> {
  const app = new Hono<RelayEnv<B>>();

  const fail = (c: Context<RelayEnv<B>>, status: Status, code: string, message: string, kind: string): Response => {
    deps.log({ route: ROUTE, status, kind });
    return c.json(errorBody(code, message), status);
  };

  app.get('/bridge', async (c) => {
    const expected = c.env.BRIDGE_TOKEN;
    if (!tokenConfigured(expected)) return fail(c, 503, 'not_configured', 'Relay is not configured', 'not_configured');
    if (!(await bearerMatches(c.req.header('authorization'), expected))) {
      return fail(c, 401, 'unauthorized', 'Missing or invalid token', 'token');
    }
    if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return fail(c, 426, 'upgrade_required', 'WebSocket upgrade required', 'upgrade');
    }
    // has(), not a value test: an empty `Origin:` header is refused too.
    if (c.req.raw.headers.has('origin')) return fail(c, 403, 'bad_origin', 'Browsers may not open the bridge socket', 'origin');
    let res: Response;
    try {
      res = await deps.hub(c.env).connectBridge(c.req.raw);
    } catch {
      return fail(c, 500, 'internal', 'Could not open the bridge socket', 'hub');
    }
    deps.log({ route: ROUTE, status: res.status, kind: 'connect' });
    // Returned as is: securityHeaders skips a 101 (R-2).
    return res;
  });

  return app;
}
