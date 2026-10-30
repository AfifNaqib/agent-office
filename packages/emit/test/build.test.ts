import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT, PKG } from './helpers.js';

const sha = (): string => createHash('sha256').update(readFileSync(BUILT)).digest('hex');
const build = (cwd: string): void => {
  execFileSync(process.execPath, [join(PKG, 'build.mjs')], { cwd, stdio: 'pipe' });
};

describe('emit build (BUG-1)', () => {
  it('gives the same bytes whatever the cwd', () => {
    build(join(PKG, '..', '..'));
    const fromRoot = sha();
    build(PKG);
    expect(sha()).toBe(fromRoot);
  }, 60_000);

  it('parallel builds never leave a partial file or temp files behind', async () => {
    const before = sha();
    const state = { running: 4 };
    const runs = Array.from(
      { length: 4 },
      () =>
        new Promise<void>((resolve, reject) => {
          execFile(process.execPath, [join(PKG, 'build.mjs')], (err) => {
            state.running -= 1;
            if (err) reject(new Error(err.message));
            else resolve();
          });
        }),
    );
    // While they run, the file must always be the complete bundle.
    let reads = 0;
    while (state.running > 0) {
      expect(sha()).toBe(before);
      reads += 1;
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(runs);
    expect(reads).toBeGreaterThan(0);
    expect(sha()).toBe(before);
    expect(readdirSync(join(PKG, 'dist')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  }, 60_000);
});
