// V1-05 under plain Node: the office web app served from the ASSETS binding, behind
// the Access guard, with the security headers. The real Workers assets binding and
// run_worker_first are covered on workerd (workerd-ws.test.ts, workerd.test.ts).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ASSET_NAME_RE, MODE_META } from '../src/routes/assets.js';
import { IMMUTABLE_CACHE, contentSecurityPolicy } from '../src/auth/guard.js';
import type { AssetsFetcher } from '../src/types.js';
import { ACCESS_ENV, BASE, TOKEN, accessJwt, startRig } from './helpers.js';

const H = 'cf-access-jwt-assertion';
const relayRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = '<!doctype html><html><head><title>Agent Office</title><script type="module" src="/assets/index-abc.js"></script></head><body></body></html>';

/** A fake assets binding: index at /, one JS and one CSS file. Records every request it gets. */
function fakeAssets(files: Record<string, { body: string; type: string }> = {}) {
  const seen: Request[] = [];
  const all: Record<string, { body: string; type: string }> = {
    '/': { body: INDEX, type: 'text/html; charset=utf-8' },
    '/assets/index-abc.js': { body: 'console.log(1)', type: 'text/javascript' },
    '/assets/index-abc.css': { body: 'body{}', type: 'text/css' },
    ...files,
  };
  const binding: AssetsFetcher = {
    fetch: (req) => {
      seen.push(req);
      const f = all[new URL(req.url).pathname];
      return Promise.resolve(f ? new Response(f.body, { headers: { 'content-type': f.type, etag: '"x"' } }) : new Response('nope', { status: 404 }));
    },
  };
  return { binding, seen };
}

function rigWithAssets(assets = fakeAssets()) {
  return { rig: startRig({ INGEST_TOKEN: TOKEN, ...ACCESS_ENV, ASSETS: assets.binding }), assets };
}

describe('V1-05 relay serves the web app behind Access', () => {
  it.each(['/', '/assets/index-abc.js', '/assets/index-abc.css', '/assets/missing.js'])('%s without a JWT: 401, the assets binding is never asked', async (path) => {
    const { rig, assets } = rigWithAssets();
    const res = await rig.fetch(path);
    expect(res.status).toBe(401);
    expect(assets.seen).toEqual([]);
    expect(res.headers.get('content-security-policy')).toBe(contentSecurityPolicy(new URL(BASE).host));
  });

  it('a forged/expired JWT: 401 for / too', async () => {
    const { rig, assets } = rigWithAssets();
    const res = await rig.fetch('/', { headers: { [H]: await accessJwt({ expOffset: -3600 }) } });
    expect(res.status).toBe(401);
    expect(assets.seen).toEqual([]);
  });

  it('GET / with a JWT: index.html with the relay mode meta, CSP and no-store, no CORS', async () => {
    const { rig, assets } = rigWithAssets();
    const res = await rig.fetch('/', { headers: { [H]: await accessJwt(), cookie: 'CF_Authorization=abc' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain(`${MODE_META}</head>`);
    expect(html).toContain('/assets/index-abc.js');
    expect(res.headers.get('content-security-policy')).toBe(contentSecurityPolicy(new URL(BASE).host));
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    // The binding gets a clean GET: no cookie, no JWT forwarded.
    expect(assets.seen).toHaveLength(1);
    expect(assets.seen[0]?.headers.get('cookie')).toBeNull();
    expect(assets.seen[0]?.headers.get(H)).toBeNull();
    expect(new URL(assets.seen[0]?.url ?? '').pathname).toBe('/');
  });

  it('GET /assets/<name> with a JWT: the file with its type and the security headers, no asset ETag', async () => {
    const { rig } = rigWithAssets();
    const res = await rig.fetch('/assets/index-abc.js', { headers: { [H]: await accessJwt() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript');
    expect(await res.text()).toBe('console.log(1)');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('etag')).toBeNull();
    const css = await rig.fetch('/assets/index-abc.css', { headers: { [H]: await accessJwt() } });
    expect(css.headers.get('content-type')).toBe('text/css');
  });

  it('L-1: /assets/<hashed name> after Access is cached for a year (immutable), CSP and nosniff kept', async () => {
    const { rig } = rigWithAssets();
    for (const path of ['/assets/index-abc.js', '/assets/index-abc.css']) {
      for (const method of ['GET', 'HEAD']) {
        const res = await rig.fetch(path, { method, headers: { [H]: await accessJwt() } });
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe(IMMUTABLE_CACHE);
        expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(res.headers.get('content-security-policy')).toBe(contentSecurityPolicy(new URL(BASE).host));
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
      }
    }
  });

  it.each([
    ['/', 'the page'],
    ['/assets/missing.js', 'a missing asset (404)'],
    ['/assets/.hidden', 'a bad asset name (404)'],
    ['/api/health', 'an API answer'],
    ['/api/events?after=0&limit=10', 'history'],
    ['/nope', 'an unknown path'],
  ])('L-1: %s (%s) with a JWT stays no-store', async (path) => {
    const { rig } = rigWithAssets();
    const res = await rig.fetch(path, { headers: { [H]: await accessJwt() } });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['/assets/index-abc.js', '/assets/index-abc.css', '/'])('L-1: %s without a JWT (401) is no-store, never immutable', async (path) => {
    const { rig } = rigWithAssets();
    const res = await rig.fetch(path);
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('L-1: no ASSETS binding on /assets/x: 503 no-store', async () => {
    const rig = startRig();
    const res = await rig.fetch('/assets/index-abc.js', { headers: { [H]: await accessJwt() } });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('HEAD / works like GET (no body)', async () => {
    const { rig } = rigWithAssets();
    const res = await rig.fetch('/', { method: 'HEAD', headers: { [H]: await accessJwt() } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).not.toBeNull();
  });

  it.each(['/index.html', '/favicon.ico', '/assets/', '/assets/a/b.js', '/assets/.hidden', '/assets/..%2fwrangler.jsonc', '/src/main.ts'])(
    '%s with a JWT: 404, never read from the binding',
    async (path) => {
      const { rig, assets } = rigWithAssets();
      const res = await rig.fetch(path, { headers: { [H]: await accessJwt() } });
      expect(res.status).toBe(404);
      expect(assets.seen).toEqual([]);
    },
  );

  it('an asset the build does not have: 404', async () => {
    const { rig } = rigWithAssets();
    const res = await rig.fetch('/assets/missing.js', { headers: { [H]: await accessJwt() } });
    expect(res.status).toBe(404);
  });

  it('POST / is not served (405/404, never the page), and needs our Origin first', async () => {
    const { rig, assets } = rigWithAssets();
    const res = await rig.fetch('/', { method: 'POST', headers: { [H]: await accessJwt(), origin: BASE } });
    expect([404, 405]).toContain(res.status);
    expect(assets.seen).toEqual([]);
  });

  it('no ASSETS binding (UI not deployed): 503, not a crash', async () => {
    const rig = startRig();
    const res = await rig.fetch('/', { headers: { [H]: await accessJwt() } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ui_not_deployed');
  });

  it('a broken index (no </head>) or a missing one: 503', async () => {
    const broken = rigWithAssets(fakeAssets({ '/': { body: '<html>', type: 'text/html' } }));
    expect((await broken.rig.fetch('/', { headers: { [H]: await accessJwt() } })).status).toBe(503);
    const none = rigWithAssets({ binding: { fetch: () => Promise.resolve(new Response('', { status: 404 })) }, seen: [] });
    expect((await none.rig.fetch('/', { headers: { [H]: await accessJwt() } })).status).toBe(503);
  });

  it('asset names: Vite output names only', () => {
    for (const ok of ['index-4IiZjbai.js', 'index-Cesu6o9p.css', 'WebGLRenderer-CTQcdwx_.js']) expect(ASSET_NAME_RE.test(ok)).toBe(true);
    for (const bad of ['', '.env', '..', 'a/b', 'a\\b', 'a%2f', 'x'.repeat(202)]) expect(ASSET_NAME_RE.test(bad)).toBe(false);
  });
});

describe('V1-05 wrangler configs: assets can never skip the Worker', () => {
  const read = (p: string): { assets?: Record<string, unknown> } =>
    JSON.parse(
      readFileSync(join(relayRoot, p), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n'),
    ) as { assets?: Record<string, unknown> };

  it.each(['wrangler.jsonc', 'test/workerd/wrangler.jsonc'])('%s: run_worker_first true, ASSETS binding, the web build folder', (p) => {
    const { assets } = read(p);
    expect(assets?.run_worker_first).toBe(true);
    expect(assets?.binding).toBe('ASSETS');
    expect(String(assets?.directory)).toMatch(/web\/dist$/);
    expect(assets?.not_found_handling).toBe('none');
  });
});
