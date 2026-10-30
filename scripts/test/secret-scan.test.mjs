import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scanText } from '../secret-scan.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'secret-scan.mjs');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Planted values are assembled at runtime so this file itself stays clean.
const PLANTED_GHP = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'ao-secret-scan-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function run(args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

describe('secret-scan CLI', () => {
  it('fails on a planted ghp_ token in a test file and never prints the value', () => {
    const root = tempDir();
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test', 'leak.test.ts'), `const t = "${PLANTED_GHP}";\n`);
    const r = run(['--root', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('leak.test.ts:1');
    expect(r.stderr).toContain('github-token');
    expect(r.stderr + r.stdout).not.toContain(PLANTED_GHP);
  });

  it('passes on a clean directory', () => {
    const root = tempDir();
    writeFileSync(join(root, 'ok.ts'), 'export const token = process.env.TOKEN;\n');
    const r = run(['--root', root]);
    expect(r.status).toBe(0);
  });

  it('skips node_modules and dist when walking a non-git directory', () => {
    const root = tempDir();
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'node_modules', 'x.js'), PLANTED_GHP);
    writeFileSync(join(root, 'dist', 'x.js'), PLANTED_GHP);
    expect(run(['--root', root]).status).toBe(0);
  });

  it('--staged scans the staged blob of a git repo', () => {
    const root = tempDir();
    const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(root, 'a.txt'), `x ${PLANTED_GHP}\n`);
    git('add', 'a.txt');
    expect(run(['--staged'], root).status).toBe(1);
  });

  it('exits 2 on a bad option', () => {
    expect(run(['--nope']).status).toBe(2);
  });

  it('this repository is clean', () => {
    const r = run([]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('secret-scan rules', () => {
  const cases = [
    ['anthropic-key', ['sk', '-ant-', 'api03-', 'x'.repeat(30)].join('')],
    ['github-fine-grained-pat', ['github', '_pat_', '11ABCDEFG0', 'x'.repeat(30)].join('')],
    ['aws-access-key-id', ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join('')],
    ['private-key-block', ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('')],
    ['slack-token', ['xo', 'xb-', '1234567890-abcdef'].join('')],
    ['quoted-secret-assignment', ['api_key = "', 'Zx9'.repeat(8), '"'].join('')],
  ];
  it.each(cases)('detects %s', (rule, text) => {
    expect(scanText(text, 'f').map((f) => f.rule)).toContain(rule);
  });

  it('does not flag env-var references or placeholders', () => {
    expect(scanText('INGEST_TOKEN: "$AGENT_OFFICE_INGEST_TOKEN_VALUE"', 'f')).toEqual([]);
    expect(scanText('"token": "<paste-the-token-here-please>"', 'f')).toEqual([]);
    expect(scanText('const token = process.env.BRIDGE_TOKEN;', 'f')).toEqual([]);
  });
});
