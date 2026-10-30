// The local UI (plan §10: GET / with the local token in a meta tag). Serves the
// built web app (packages/web/dist): index.html with the token injected, and the
// hashed files under /assets/. Same origin as /api and /ws, so the WebSocket
// Origin check and the Host allowlist cover it. Files are read per request, so a
// rebuild shows up on reload without restarting the bridge.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { deny, type BridgeEnv } from './security.js';

/** Vite output names: letters, digits, `_ - .`, no leading dot, so no traversal. */
const ASSET_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}$/;
const TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
};
export const TOKEN_META = 'agent-office-token';

export interface UiDeps {
  /** Folder with index.html and assets/ (the web build). */
  readonly webDir: string;
  readonly getToken: () => string;
}

export function uiRoutes(deps: UiDeps): Hono<BridgeEnv> {
  const app = new Hono<BridgeEnv>();

  app.get('/', async (c) => {
    let html: string;
    try {
      html = await readFile(join(deps.webDir, 'index.html'), 'utf8');
    } catch {
      return deny(c, 404, 'ui_not_built', 'UI not built: run `npm run build -w @agent-office/web`');
    }
    // The token charset is [A-Za-z0-9_-] (config.ts), so it is safe inside an attribute.
    const meta = `<meta name="${TOKEN_META}" content="${deps.getToken()}" />`;
    c.header('X-Frame-Options', 'DENY');
    return c.html(html.replace('</head>', `${meta}</head>`));
  });

  app.get('/assets/:name', async (c) => {
    const name = c.req.param('name');
    const type = TYPES[name.slice(name.lastIndexOf('.') + 1)];
    if (!ASSET_RE.test(name) || type === undefined) return deny(c, 404, 'not_found', 'Not found');
    try {
      const body = await readFile(join(deps.webDir, 'assets', name));
      return c.body(body, 200, { 'Content-Type': type });
    } catch {
      return deny(c, 404, 'not_found', 'Not found');
    }
  });

  return app;
}
