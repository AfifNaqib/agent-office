// The office web app (V1-05, plan §9 "Workers static assets for the UI"). The built
// packages/web/dist is uploaded as the Worker's static assets, and wrangler.jsonc
// sets `run_worker_first: true`, so EVERY request runs this Worker first: the
// runtime never answers from the assets on its own. The Access guard therefore
// runs before any file is served, and only these two routes reach the ASSETS
// binding:
//   GET /                 index.html + the relay mode meta tag (the page then talks to
//                         /api/events and /ws/ui, see packages/web/src/live.ts)
//   GET /assets/<name>    the hashed JS/CSS files of the build (Vite output names only)
// Anything else (/index.html, /favicon.ico, nested paths) is our 404. The security
// headers (CSP etc.) are added by securityHeaders like on every other response.
// Cache: /assets/* files are `public, max-age=31536000, immutable`; / and errors are no-store.
import { Hono, type Context } from 'hono';
import { IMMUTABLE_CACHE } from '../auth/guard.js';
import { errorBody, type RelayBindings, type RelayEnv } from '../types.js';

/** Vite output names: letters, digits, `_ - .`, no leading dot, so no traversal (same rule as the bridge). */
export const ASSET_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}$/;
export const MODE_META = '<meta name="agent-office-mode" content="relay" />';

function notBuilt<B extends RelayBindings>(c: Context<RelayEnv<B>>): Response {
  return c.json(errorBody('ui_not_deployed', 'Office UI not deployed: npm run deploy:relay builds it'), 503);
}

/** Fetches one file from the assets binding with a clean GET (no client headers, cookies or JWT). */
async function fromAssets<B extends RelayBindings>(c: Context<RelayEnv<B>>, path: string): Promise<Response | null> {
  const assets = c.env.ASSETS;
  if (!assets) return null;
  return assets.fetch(new Request(new URL(path, c.req.url), { method: 'GET' }));
}

export function assetRoutes<B extends RelayBindings>(): Hono<RelayEnv<B>> {
  const app = new Hono<RelayEnv<B>>();

  app.get('/', async (c) => {
    const res = await fromAssets(c, '/');
    if (res?.status !== 200) return notBuilt(c);
    const html = await res.text();
    if (!html.includes('</head>')) return notBuilt(c);
    return c.html(html.replace('</head>', `${MODE_META}</head>`));
  });

  app.get('/assets/:name', async (c) => {
    const name = c.req.param('name');
    if (!ASSET_NAME_RE.test(name)) return c.json(errorBody('not_found', 'Not found'), 404);
    const res = await fromAssets(c, `/assets/${name}`);
    if (!res) return notBuilt(c);
    if (res.status !== 200) return c.json(errorBody('not_found', 'Not found'), 404);
    const type = res.headers.get('content-type') ?? 'application/octet-stream';
    // Only the body and type are passed on (no asset ETag/cache headers). Vite names carry a
    // content hash, so the browser may keep the file for a year (L-1); securityHeaders adds
    // the rest and leaves this Cache-Control alone. This route only runs after the Access guard.
    return new Response(res.body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': IMMUTABLE_CACHE } });
  });

  return app;
}
