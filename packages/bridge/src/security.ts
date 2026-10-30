// Request guards (plan §11, "Bridge local"): loopback bind is done by the server;
// here are the Host allowlist against DNS rebinding, request-target sanity, the
// constant-time LOCAL_TOKEN check and the response headers. No CORS headers, ever:
// a cross-origin page cannot send the token header without a preflight, and the
// preflight (OPTIONS) gets no CORS answer.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import type { Context, MiddlewareHandler } from 'hono';

export type BridgeEnv = { Bindings: HttpBindings };

export const LOCAL_TOKEN_HEADER = 'X-Agent-Office-Local';

export function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** `127.0.0.1:<port>` and `localhost:<port>`; nothing else (not `[::1]`: the server does not listen there). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** How many Host headers the client really sent (node folds duplicates, which would hide a second one). */
export function hostHeaderCount(req: Pick<IncomingMessage, 'rawHeaders'>): number {
  let n = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === 'host') n += 1;
  return n;
}

/** origin-form only ("/path?query"): no absolute-form (which would override Host), no "//", no authority-form. */
export function requestTargetOk(url: string | undefined): boolean {
  return url !== undefined && url.startsWith('/') && !url.startsWith('//');
}

/** Constant-time: compares fixed-length digests, so neither content nor length leaks through timing. */
export function tokensEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function deny(c: Context, status: 400 | 401 | 404 | 413 | 421 | 500 | 503, code: string, message: string): Response {
  return c.json(errorBody(code, message), status);
}

/** First middleware: request target, exactly one allowed Host, response headers. */
export function guard(getPort: () => number): MiddlewareHandler<BridgeEnv> {
  return async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const incoming = c.env.incoming;
    if (!requestTargetOk(incoming.url)) return deny(c, 400, 'bad_request', 'Bad request target');
    if (hostHeaderCount(incoming) !== 1 || !hostAllowed(incoming.headers.host, getPort())) {
      return deny(c, 421, 'bad_host', 'Misdirected request');
    }
    await next();
    return undefined;
  };
}

/** Route middleware: X-Agent-Office-Local must equal the local token. */
export function requireToken(getToken: () => string): MiddlewareHandler<BridgeEnv> {
  return async (c, next) => {
    const provided = c.req.header(LOCAL_TOKEN_HEADER);
    if (provided === undefined || !tokensEqual(provided, getToken())) {
      return deny(c, 401, 'unauthorized', 'Missing or invalid token');
    }
    await next();
    return undefined;
  };
}
