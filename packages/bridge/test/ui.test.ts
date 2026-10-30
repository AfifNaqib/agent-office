// V0-03: the bridge serves the built web app at / with the local token in a meta tag.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN, call, startRig, stopAll, tempDir } from './helpers.js';

afterEach(async () => {
  await stopAll();
});

function webBuild(): string {
  const dir = tempDir('ao-web-');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'nope');
  return dir;
}

describe('UI routes', () => {
  it('GET / injects the token meta tag and needs only the Host check', async () => {
    const rig = await startRig({ webDir: webBuild() });
    const r = await call(rig.port, '/', { token: false });
    expect(r.status).toBe(200);
    expect(r.body).toContain(`<meta name="agent-office-token" content="${TOKEN}" /></head>`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('a wrong Host never gets the page (DNS rebinding)', async () => {
    const rig = await startRig({ webDir: webBuild() });
    const r = await call(rig.port, '/', { token: false, host: 'evil.example:80' });
    expect(r.status).toBe(421);
    expect(r.body).not.toContain(TOKEN);
  });

  it('serves hashed assets with a type; nothing outside assets/, no traversal, no unknown types', async () => {
    const rig = await startRig({ webDir: webBuild() });
    const js = await call(rig.port, '/assets/index-abc.js', { token: false });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    for (const p of ['/assets/..%2Fsecret.txt', '/assets/%2e%2e%2fsecret.txt', '/secret.txt', '/assets/missing.js', '/assets/.hidden.js', '/assets/x.txt']) {
      const r = await call(rig.port, p, { token: false });
      expect(r.status, p).toBe(404);
      expect(r.body).not.toContain('nope');
    }
  });

  it('a missing build says how to build it; no webDir means no UI route', async () => {
    const empty = await startRig({ webDir: tempDir('ao-web-empty-') });
    const r = await call(empty.port, '/', { token: false });
    expect(r.status).toBe(404);
    expect(r.body).toContain('ui_not_built');
    const none = await startRig();
    expect((await call(none.port, '/', { token: false })).status).toBe(404);
  });
});
