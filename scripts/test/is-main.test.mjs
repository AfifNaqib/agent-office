import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isMain } from '../lib/is-main.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'is-main-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('isMain (BUG-05)', () => {
  const self = join(SCRIPTS, 'gen-token.mjs');
  const url = pathToFileURL(self).href;

  it('true for the script itself, false for another file or no argv[1]', () => {
    expect(isMain(url, self)).toBe(true);
    expect(isMain(url, join(SCRIPTS, 'secret-scan.mjs'))).toBe(false);
    expect(isMain(url, undefined)).toBe(false);
    expect(isMain(url, '')).toBe(false);
  });

  it('Windows: drive letter / folder casing does not matter on win32 only', () => {
    expect(isMain(url, self.toUpperCase(), 'win32')).toBe(true);
    expect(isMain(url, self.toUpperCase(), 'linux')).toBe(false);
  });

  it('a symlinked script still runs (gen-token prints a token)', () => {
    const link = join(tmp, 'gt-link.mjs');
    symlinkSync(self, link);
    expect(isMain(url, link)).toBe(true);
    const r = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
  });

  it('a script reached through a symlinked folder (junction-like) still runs (secret-scan)', () => {
    const dirLink = join(tmp, 'scripts-link');
    symlinkSync(SCRIPTS, dirLink, 'dir');
    const clean = join(tmp, 'clean.txt');
    writeFileSync(clean, 'nothing to see\n');
    const r = spawnSync(process.execPath, [join(dirLink, 'secret-scan.mjs'), clean], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/clean/);
  });
});
