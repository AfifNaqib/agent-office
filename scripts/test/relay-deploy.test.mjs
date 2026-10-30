import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REDIRECT_CONFIG,
  RELAY_DIR,
  REPO_ROOT,
  WEB_DIR,
  deployRelay,
  dirtyPaths,
  evaluateSecrets,
  findVite,
  findWrangler,
  hiddenChangePaths,
  nodeTooOld,
  parseGitStatus,
  parseSecretList,
  secretsCheck,
} from '../lib/relay.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = '/fake/wrangler.js';
const VITE = '/fake/vite.js';
const ALL = ['INGEST_TOKEN', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'BRIDGE_TOKEN'];
// Looks like a secret value; must never appear in any output.
const CANARY = ['canary', 'VALUE', 'x9Q2', 'never-print'].join('-');

const list = (names) =>
  JSON.stringify(
    names.map((name) => ({ name, type: 'secret_text' })),
    null,
    '  ',
  );

/**
 * Fake runner: answers by command. Records every call.
 * @param {{ secrets?: object, git?: object, lsFiles?: object, ancestor?: object,
 *   head?: object, deploy?: object, exists?: string[] }} [answers]
 */
function fake(answers = {}) {
  const calls = [];
  const out = [];
  const errs = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (args[0] === VITE) return answers.vite ?? ok('');
    if (cmd === 'git' && args[0] === 'status') return answers.git ?? ok('');
    if (cmd === 'git' && args[0] === 'ls-files') return answers.lsFiles ?? ok('H packages/relay/src/app.ts\0');
    if (cmd === 'git' && args[0] === 'merge-base') return answers.ancestor ?? ok('');
    if (cmd === 'git' && args[0] === 'rev-parse') return answers.head ?? ok('0123456789ab\n');
    if (args.includes('secret')) return answers.secrets ?? ok(list(ALL));
    if (args.includes('deploy')) return answers.deploy ?? ok('');
    throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
  };
  const deps = {
    run,
    log: (s) => out.push(s),
    err: (s) => errs.push(s),
    wrangler: WRANGLER,
    vite: VITE,
    nodeVersion: 'v22.13.0',
    exists: (p) => (answers.exists ?? []).includes(p),
  };
  return { deps, calls, out, errs, text: () => [...out, ...errs].join('\n') };
}

describe('parseSecretList', () => {
  it('reads the names from wrangler JSON output', () => {
    expect(parseSecretList(list(['INGEST_TOKEN', 'ACCESS_AUD']))).toEqual([
      'INGEST_TOKEN',
      'ACCESS_AUD',
    ]);
  });

  it('accepts an empty list', () => {
    expect(parseSecretList('[]\n')).toEqual([]);
  });

  it('skips noise lines before the JSON (banners, warnings, CRLF)', () => {
    const stdout = `▲ [WARNING] Proxy environment variables detected.\r\n\r\n${list(['INGEST_TOKEN']).replace(/\n/g, '\r\n')}\r\n`;
    expect(parseSecretList(stdout)).toEqual(['INGEST_TOKEN']);
  });

  it('ignores any extra fields (never returns them)', () => {
    const stdout = JSON.stringify([{ name: 'INGEST_TOKEN', type: 'secret_text', text: CANARY }]);
    expect(parseSecretList(stdout)).toEqual(['INGEST_TOKEN']);
  });

  it.each([
    ['empty output', ''],
    ['no list', 'Secret Name: INGEST_TOKEN\n'],
    ['broken JSON', '[{"name": "INGEST_TOKEN"'],
    ['object, not list', '{"name":"INGEST_TOKEN"}'],
    ['entry without name', '[{"type":"secret_text"}]'],
    ['non-string name', '[{"name":42}]'],
    ['bad name chars', '[{"name":"INGEST TOKEN"}]'],
    ['null entry', '[null]'],
  ])('throws on %s', (_label, stdout) => {
    expect(() => parseSecretList(stdout)).toThrow();
  });
});

describe('evaluateSecrets', () => {
  it('all present: ok, nothing missing or later', () => {
    expect(evaluateSecrets(ALL)).toEqual({ missing: [], later: [], ok: true });
  });

  it('V1-04: BRIDGE_TOKEN missing is an error now', () => {
    const r = evaluateSecrets(['INGEST_TOKEN', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']);
    expect(r).toEqual({ missing: ['BRIDGE_TOKEN'], later: [], ok: false });
  });

  it('V1-02: ACCESS_TEAM_DOMAIN or ACCESS_AUD missing is an error now', () => {
    expect(evaluateSecrets(['INGEST_TOKEN', 'BRIDGE_TOKEN'])).toMatchObject({ ok: false, missing: ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'] });
    expect(evaluateSecrets(['INGEST_TOKEN', 'ACCESS_AUD', 'BRIDGE_TOKEN'])).toMatchObject({ ok: false, missing: ['ACCESS_TEAM_DOMAIN'] });
    expect(evaluateSecrets(['INGEST_TOKEN', 'ACCESS_TEAM_DOMAIN', 'BRIDGE_TOKEN'])).toMatchObject({ ok: false, missing: ['ACCESS_AUD'] });
  });

  it('INGEST_TOKEN missing: not ok', () => {
    const r = evaluateSecrets(['BRIDGE_TOKEN', 'ingest_token', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['INGEST_TOKEN']);
  });
});

describe('git status parsing', () => {
  it('parses -z entries, skips the source path of renames', () => {
    const z = [' M package.json', 'R  new.ts', 'old.ts', '?? packages/relay/x.ts', ''].join('\0');
    expect(parseGitStatus(z)).toEqual([
      { code: ' M', path: 'package.json' },
      { code: 'R ', path: 'new.ts' },
      { code: '??', path: 'packages/relay/x.ts' },
    ]);
  });

  it('keeps paths with spaces and quotes as-is', () => {
    expect(parseGitStatus(' M docs/a b"c.md\0')).toEqual([{ code: ' M', path: 'docs/a b"c.md' }]);
  });

  it('clean tree: nothing dirty', () => {
    expect(dirtyPaths(parseGitStatus(''))).toEqual([]);
  });

  it('tracked changes anywhere are dirty; untracked only inside relay/core/web (web since V1-05)', () => {
    const z = [
      ' M README.md',
      'A  scripts/new.mjs',
      'D  docs/old.md',
      '?? graphify-out/graph.json',
      '?? packages/bridge/tmp.txt',
      '?? packages/relay/src/extra.ts',
      '?? packages/core/src/x.ts',
      '',
    ].join('\0');
    expect(dirtyPaths(parseGitStatus(z))).toEqual([
      'README.md',
      'scripts/new.mjs',
      'docs/old.md',
      'packages/relay/src/extra.ts',
      'packages/core/src/x.ts',
    ]);
  });

  it('only untracked files outside the deployed source: clean', () => {
    expect(dirtyPaths(parseGitStatus('?? graphify-out/a.json\0?? notes.txt\0'))).toEqual([]);
  });
});

describe('hiddenChangePaths', () => {
  it('finds assume-unchanged (lowercase) and skip-worktree (S) entries only', () => {
    const z = [
      'H packages/relay/src/app.ts',
      'h packages/relay/src/hidden.ts',
      'S packages/core/src/skip.ts',
      's packages/core/src/both.ts',
      'M packages/core/src/merge.ts',
      'C packages/core/src/changed.ts',
      'R packages/core/src/removed.ts',
      '? packages/relay/x',
      '',
    ].join('\0');
    expect(hiddenChangePaths(z)).toEqual([
      'packages/relay/src/hidden.ts',
      'packages/core/src/skip.ts',
      'packages/core/src/both.ts',
    ]);
  });

  it('empty output: nothing hidden', () => {
    expect(hiddenChangePaths('')).toEqual([]);
  });
});

describe('nodeTooOld', () => {
  it.each([
    ['v18.19.0', true],
    ['v20.11.1', true],
    ['v21.7.0', true],
    ['v22.0.0', true],
    ['v22.12.9', true],
    ['v22.13.0', false],
    ['v22.20.1', false],
    ['v23.0.0', false],
    ['v24.1.0', false],
    ['garbage', true],
  ])('%s -> %s', (v, expected) => {
    expect(nodeTooOld(v)).toBe(expected);
  });
});

describe('secretsCheck', () => {
  it('all secrets present: exit 0, no warnings', () => {
    const f = fake();
    expect(secretsCheck(f.deps)).toBe(0);
    expect(f.out).toContain('secrets: ok');
    expect(f.text()).not.toMatch(/warning|MISSING/);
    const c = f.calls[0];
    expect(c.cmd).toBe(process.execPath);
    expect(c.args).toEqual([WRANGLER, 'secret', 'list', '--format', 'json']);
    expect(c.opts).toEqual({ cwd: RELAY_DIR, capture: true });
  });

  it('V1-04: BRIDGE_TOKEN missing: exit 1, MISSING BRIDGE_TOKEN', () => {
    const f = fake({ secrets: { status: 0, stdout: list(['INGEST_TOKEN', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']), stderr: '' } });
    expect(secretsCheck(f.deps)).toBe(1);
    expect(f.out).toContain('MISSING BRIDGE_TOKEN');
    expect(f.errs.join('\n')).toMatch(/missing required secret\(s\): BRIDGE_TOKEN/);
  });

  it('only INGEST_TOKEN (V1-02): exit 1, both Access secrets MISSING', () => {
    const f = fake({ secrets: { status: 0, stdout: list(['INGEST_TOKEN']), stderr: '' } });
    expect(secretsCheck(f.deps)).toBe(1);
    expect(f.out).toContain('MISSING ACCESS_TEAM_DOMAIN');
    expect(f.out).toContain('MISSING ACCESS_AUD');
    expect(f.errs.join('\n')).toMatch(/missing required secret\(s\): ACCESS_TEAM_DOMAIN, ACCESS_AUD/);
  });

  it('INGEST_TOKEN missing: exit 1', () => {
    const f = fake({ secrets: { status: 0, stdout: list(['BRIDGE_TOKEN']), stderr: '' } });
    expect(secretsCheck(f.deps)).toBe(1);
    expect(f.out).toContain('MISSING INGEST_TOKEN');
    expect(f.errs.join('\n')).toMatch(/missing required secret\(s\): INGEST_TOKEN/);
  });

  it('wrangler fails (not logged in / Worker not found): exit 2 with a hint', () => {
    const f = fake({
      secrets: { status: 1, stdout: '', stderr: 'X [ERROR] Worker "agent-office" not found.' },
    });
    expect(secretsCheck(f.deps)).toBe(2);
    expect(f.errs.join('\n')).toMatch(/secret list` failed/);
    expect(f.errs.join('\n')).toMatch(/not found/);
    expect(f.errs.join('\n')).toMatch(/hint:/);
  });

  it('wrangler could not start: exit 2', () => {
    const f = fake({ secrets: { status: null, stdout: '', stderr: '', error: 'spawn ENOENT' } });
    expect(secretsCheck(f.deps)).toBe(2);
    expect(f.errs).toContain('spawn ENOENT');
  });

  it('unparsable output: exit 2', () => {
    const f = fake({ secrets: { status: 0, stdout: 'Secret Name: INGEST_TOKEN', stderr: '' } });
    expect(secretsCheck(f.deps)).toBe(2);
  });

  it('never prints extra fields from wrangler output', () => {
    const stdout = JSON.stringify([
      { name: 'INGEST_TOKEN', type: 'secret_text', text: CANARY },
      { name: 'ACCESS_TEAM_DOMAIN', type: 'secret_text', text: CANARY },
      { name: 'ACCESS_AUD', type: 'secret_text', text: CANARY },
      { name: 'BRIDGE_TOKEN', type: 'secret_text', text: CANARY },
    ]);
    const f = fake({ secrets: { status: 0, stdout, stderr: '' } });
    expect(secretsCheck(f.deps)).toBe(0);
    expect(f.text()).not.toContain(CANARY);
  });

  it('old Node: exit 2 before running anything', () => {
    const f = fake();
    f.deps.nodeVersion = 'v20.11.1';
    expect(secretsCheck(f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
    expect(f.errs.join('\n')).toMatch(/Node v20\.11\.1 is too old/);
  });

  it('wrangler not installed: exit 2 before running anything', () => {
    const f = fake();
    f.deps.wrangler = null;
    expect(secretsCheck(f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
    expect(f.errs.join('\n')).toMatch(/npm ci/);
  });
});

describe('deployRelay', () => {
  it('V1-05: builds the web app (vite, in packages/web) right before wrangler deploy', () => {
    const f = fake();
    expect(deployRelay(f.deps)).toBe(0);
    const build = f.calls.at(-2);
    expect(build).toEqual({ cmd: process.execPath, args: [VITE, 'build'], opts: { cwd: WEB_DIR } });
    expect(f.calls.at(-1).args).toContain('deploy');
  });

  it('V1-05: web build fails: refused, nothing deployed', () => {
    const f = fake({ vite: { status: 3, stdout: '', stderr: '' } });
    expect(deployRelay(f.deps)).toBe(3);
    expect(f.calls.some((c) => c.args.includes('deploy'))).toBe(false);
    expect(f.errs.join('\n')).toMatch(/web build failed; deploy refused/);
  });

  it('V1-05: vite not installed: exit 2 before running anything', () => {
    const f = fake();
    f.deps.vite = null;
    expect(deployRelay(f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
  });

  it('V1-05: untracked files in packages/web block the deploy (they would be built into the UI)', () => {
    const f = fake({ git: { status: 0, stdout: '?? packages/web/src/x.ts\0', stderr: '' } });
    expect(deployRelay(f.deps)).toBe(1);
  });

  it('clean tree + secrets ok: runs wrangler deploy in packages/relay, labelled with the commit', () => {
    const f = fake();
    expect(deployRelay(f.deps)).toBe(0);
    const deploy = f.calls.at(-1);
    expect(deploy.cmd).toBe(process.execPath);
    expect(deploy.args).toEqual([WRANGLER, 'deploy', '--message', 'git 0123456789ab']);
    expect(deploy.opts).toEqual({ cwd: RELAY_DIR });
    expect(f.calls[0]).toEqual({
      cmd: 'git',
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      opts: { cwd: REPO_ROOT, capture: true },
    });
    expect(f.out.join('\n')).toMatch(/api\/health/);
  });

  it('dirty tree: refused, secrets not checked, nothing deployed', () => {
    const f = fake({ git: { status: 0, stdout: ' M packages/relay/src/app.ts\0', stderr: '' } });
    expect(deployRelay(f.deps)).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(f.errs.join('\n')).toMatch(/dirty; deploy refused/);
    expect(f.errs).toContain('  packages/relay/src/app.ts');
  });

  it('dirty tree with many files: lists 20 and a count', () => {
    const z = Array.from({ length: 25 }, (_, i) => ` M f${i}.ts`).join('\0');
    const f = fake({ git: { status: 0, stdout: z, stderr: '' } });
    expect(deployRelay(f.deps)).toBe(1);
    expect(f.errs).toContain('  ... and 5 more');
  });

  it('untracked file outside the deployed source does not block', () => {
    const f = fake({ git: { status: 0, stdout: '?? graphify-out/x.json\0', stderr: '' } });
    expect(deployRelay(f.deps)).toBe(0);
  });

  it('git fails (not a repo / git missing): refused', () => {
    const f = fake({ git: { status: null, stdout: '', stderr: '', error: 'spawn git ENOENT' } });
    expect(deployRelay(f.deps)).toBe(2);
    expect(f.calls).toHaveLength(1);
  });

  it('INGEST_TOKEN missing: refused, nothing deployed', () => {
    const f = fake({ secrets: { status: 0, stdout: '[]', stderr: '' } });
    expect(deployRelay(f.deps)).toBe(1);
    expect(f.calls.some((c) => c.args.includes('deploy'))).toBe(false);
    expect(f.errs.join('\n')).toMatch(/secrets check failed; deploy refused/);
  });

  it('secret list fails: refused, nothing deployed', () => {
    const f = fake({ secrets: { status: 1, stdout: '', stderr: 'auth error' } });
    expect(deployRelay(f.deps)).toBe(2);
    expect(f.calls.some((c) => c.args.includes('deploy'))).toBe(false);
  });

  it('V1-04: BRIDGE_TOKEN missing: deploy refused', () => {
    const f = fake({ secrets: { status: 0, stdout: list(['INGEST_TOKEN', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']), stderr: '' } });
    expect(deployRelay(f.deps)).toBe(1);
    expect(f.calls.some((c) => c.args.includes('deploy'))).toBe(false);
  });

  it('wrangler deploy fails: its exit code is returned', () => {
    const f = fake({ deploy: { status: 7, stdout: '', stderr: '' } });
    expect(deployRelay(f.deps)).toBe(7);
    expect(f.errs.join('\n')).toMatch(/deploy failed/);
  });

  it('odd rev-parse output: deploys without a --message', () => {
    const f = fake({ head: { status: 0, stdout: 'not a sha; rm -rf /\n', stderr: '' } });
    expect(deployRelay(f.deps)).toBe(0);
    expect(f.calls.at(-1).args).toEqual([WRANGLER, 'deploy']);
  });

  it('checks ls-files for the deployed source and ancestry against the local origin/main', () => {
    const f = fake();
    expect(deployRelay(f.deps)).toBe(0);
    expect(f.calls[1]).toEqual({
      cmd: 'git',
      args: ['ls-files', '-v', '-z', '--', 'packages/relay/', 'packages/core/', 'packages/web/'],
      opts: { cwd: REPO_ROOT, capture: true },
    });
    expect(f.calls[2].args).toEqual(['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
    expect(f.calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(false);
    expect(f.errs.join('\n')).not.toMatch(/warning/);
  });

  it.each([
    ['assume-unchanged', 'h packages/relay/src/app.ts\0'],
    ['skip-worktree', 'S packages/core/src/redact.ts\0'],
  ])('%s file in the deployed source: refused, nothing deployed', (_label, z) => {
    const f = fake({ lsFiles: { status: 0, stdout: z, stderr: '' } });
    expect(deployRelay(f.deps)).toBe(1);
    expect(f.calls).toHaveLength(2);
    expect(f.errs.join('\n')).toMatch(/assume-unchanged or skip-worktree/);
    expect(f.errs).toContain(`  ${z.slice(2, -1)}`);
  });

  it('git ls-files fails: refused', () => {
    const f = fake({ lsFiles: { status: 128, stdout: '', stderr: 'fatal' } });
    expect(deployRelay(f.deps)).toBe(2);
    expect(f.calls).toHaveLength(2);
  });

  it('wrangler redirect config present: refused, nothing deployed', () => {
    const f = fake({ exists: [REDIRECT_CONFIG] });
    expect(deployRelay(f.deps)).toBe(1);
    expect(f.calls.some((c) => c.args.includes('deploy') || c.args.includes('secret'))).toBe(false);
    expect(f.errs.join('\n')).toMatch(/\.wrangler\/deploy\/config\.json exists/);
  });

  it('REDIRECT_CONFIG points into packages/relay/.wrangler/deploy', () => {
    expect(REDIRECT_CONFIG).toBe(join(RELAY_DIR, '.wrangler', 'deploy', 'config.json'));
  });

  it('HEAD not on origin/main: warns (git pull + npm ci) but deploys', () => {
    const f = fake({ ancestor: { status: 1, stdout: '', stderr: '' } });
    expect(deployRelay(f.deps)).toBe(0);
    const errs = f.errs.join('\n');
    expect(errs).toMatch(/warning: this commit is not on origin\/main/);
    expect(errs).toMatch(/git pull/);
    expect(errs).toMatch(/npm ci/);
    expect(f.calls.at(-1).args).toContain('deploy');
  });

  it('origin/main missing (merge-base error): warns, deploys', () => {
    const f = fake({ ancestor: { status: 128, stdout: '', stderr: 'fatal: Not a valid object name' } });
    expect(deployRelay(f.deps)).toBe(0);
    expect(f.errs.join('\n')).toMatch(/could not compare with origin\/main/);
    expect(f.calls.at(-1).args).toContain('deploy');
  });

  it('old Node: refused before git or wrangler run', () => {
    const f = fake();
    f.deps.nodeVersion = 'v18.20.0';
    expect(deployRelay(f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
  });
});

describe('CLIs', () => {
  it('findWrangler resolves the installed wrangler entry', () => {
    const bin = findWrangler();
    expect(bin).toMatch(/wrangler[\\/]bin[\\/]wrangler\.js$/);
    expect(bin && existsSync(bin)).toBe(true);
  });

  it('findVite resolves the installed vite entry (V1-05 web build)', () => {
    const bin = findVite();
    expect(bin).toMatch(/vite[\\/]bin[\\/]vite\.js$/);
    expect(bin && existsSync(bin)).toBe(true);
  });

  it.each(['secrets-check.mjs', 'deploy-relay.mjs'])('%s refuses unknown options (exit 2)', (f) => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, f), '--force'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
    expect(r.stdout).toBe('');
  });
});
