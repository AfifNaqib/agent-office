// Route guard (V1-02): which paths skip Access, the Access JWT check for every other
// path, the Origin check for state-changing requests and WebSocket upgrades, and the
// security headers every response carries.
//
// Path matching is on the RAW pathname (percent-encoding kept, see `rawPath`), and the
// app routes on the same raw pathname. So `/%69ngest`, `/INGEST`, `/ingest/`,
// `/ingest/x` or `/ingest;x` are not the bypass path: they need the JWT like any other
// protected path, and none of them reaches the /ingest handler.
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../log.js';
import { errorBody, type RelayBindings, type RelayEnv } from '../types.js';
import { accessConfig, verifyAccess, type KeySource } from './access.js';

/** Exactly the paths the Access bypass app lists (S5): they check their own tokens. */
export const BYPASS_PATHS: ReadonlySet<string> = new Set(['/ingest', '/bridge']);

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * The pathname exactly as sent (after WHATWG URL parsing, which resolves dot segments
 * but keeps percent-escapes). Hono's default getPath percent-DECODES, which would let
 * `/%69ngest` route to `/ingest`; the app uses this instead.
 */
export function rawPath(request: Request): string {
  return new URL(request.url).pathname;
}

export function isBypass(path: string): boolean {
  return BYPASS_PATHS.has(path);
}

/** Plan §11 CSP, with connect-src narrowed to this host's wss (not every wss: origin). */
export function contentSecurityPolicy(host: string): string {
  return [
    "default-src 'self'",
    `connect-src 'self' wss://${host}`,
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * L-1: the long-lived cache policy of the hashed build files (`/assets/<vite name>`).
 * `public` only means "the browser may keep it"; the page and every API/error answer
 * stay `no-store`, so no login-gated HTML or data is ever cached, shared or not.
 */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/** True for a response the asset route marked as an immutable build file (GET/HEAD 200 under /assets/ only). */
function keepsImmutableCache(method: string, path: string, res: Response): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    path.startsWith('/assets/') &&
    res.status === 200 &&
    res.headers.get('cache-control') === IMMUTABLE_CACHE
  );
}

/** Security headers on every response (HTML now in V1-05, JSON and errors today). No CORS headers ever. */
export function securityHeaders<B extends RelayBindings>(): MiddlewareHandler<RelayEnv<B>> {
  return async (c, next) => {
    await next();
    // R-2: a 101 WebSocket answer must go out untouched. Hono's c.header() after
    // next() rebuilds the Response (new Response(body, res)), which can drop the
    // socket; headers on a 101 are useless to a browser anyway.
    if (c.res.status === 101) return;
    const host = new URL(c.req.url).host;
    c.header('Content-Security-Policy', contentSecurityPolicy(host));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    // Everything is no-store except a build file the asset route served (after the Access guard passed).
    if (!keepsImmutableCache(c.req.method, rawPath(c.req.raw), c.res)) c.header('Cache-Control', 'no-store');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Strict-Transport-Security', 'max-age=31536000');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  };
}

export interface GuardDeps {
  readonly keys: KeySource;
  readonly now: () => number;
  readonly log: Logger;
}

function isWebSocketUpgrade(headers: Headers): boolean {
  return (headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
}

/**
 * Access JWT on every non-bypass path (401/403, 503 when the Access settings are
 * missing), then the Origin check: a state-changing method or a WebSocket upgrade
 * needs `Origin` equal to this relay's own origin (403 otherwise, also when absent).
 */
export function accessGuard<B extends RelayBindings>(deps: GuardDeps): MiddlewareHandler<RelayEnv<B>> {
  return async (c, next) => {
    const path = rawPath(c.req.raw);
    if (isBypass(path)) return next();

    const config = accessConfig(c.env);
    if (!config) {
      deps.log({ route: 'access', status: 503, kind: 'not_configured' });
      return c.json(errorBody('not_configured', 'Relay is not configured'), 503);
    }
    const result = await verifyAccess(c.req.raw.headers, config, deps.keys, deps.now);
    if (!result.ok) {
      deps.log({ route: 'access', status: result.status, kind: result.reason });
      if (result.status === 403) return c.json(errorBody('forbidden', 'Not allowed'), 403);
      if (result.status === 503) return c.json(errorBody('unavailable', 'Cannot check the login right now'), 503);
      return c.json(errorBody('unauthorized', 'Missing or invalid Access login'), 401);
    }

    const needsOrigin = !SAFE_METHODS.has(c.req.method) || isWebSocketUpgrade(c.req.raw.headers);
    if (needsOrigin && c.req.header('origin') !== new URL(c.req.url).origin) {
      deps.log({ route: 'access', status: 403, kind: 'origin' });
      return c.json(errorBody('bad_origin', 'Cross-origin request refused'), 403);
    }
    c.set('access', { email: result.email, expMs: result.expMs });
    return next();
  };
}
