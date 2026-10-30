// `run()` against temp dirs: the whole installer minus the CLI shell.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_PORT } from '../../packages/emit/src/destination.js';
import { run } from '../lib/install.mjs';
import { HOOK_KIND } from '@agent-office/core';
import { DEFAULT_PORT } from '../lib/setup-data.mjs';
import { backupOnce, stamp } from '../lib/settings-file.mjs';

const FIX = join(import.meta.dirname, 'fixtures');
const BEFORE = readFileSync(join(FIX, 'settings-before.json'), 'utf8');

function rig({ settings = BEFORE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ao-inst-'));
  const home = join(root, 'home dir'); // a space on purpose
  const dataDir = join(home, '.agent-office');
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsFile = join(claudeDir, 'settings.json');
  if (settings !== null) writeFileSync(settingsFile, settings);
  const emitBuilt = join(root, 'built-emit.mjs');
  writeFileSync(emitBuilt, '// built emit\n');
  const env = { HOME: home, AGENT_OFFICE_HOME: dataDir };
  // settingsFile is always explicit: a test env with a Windows-style USERPROFILE must never resolve a path inside the repo.
  const go = (o = {}) => run({ target: 'user', emitBuilt, env, withData: true, platform: 'linux', settingsFile, ...o });
  return { root, home, dataDir, claudeDir, settingsFile, emitBuilt, env, go };
}

function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p}:${statSync(p).size}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe('constants shared with the emit script', () => {
  it('default port and the 12 events agree with packages/emit and core', () => {
    expect(DEFAULT_PORT).toBe(DEFAULT_BRIDGE_PORT);
  });
  it('the user template covers every FR-001 event', () => {
    const tpl = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'hooks-config', 'user-settings.json'), 'utf8'));
    expect(Object.keys(tpl.hooks).sort()).toEqual(Object.keys(HOOK_KIND).sort());
  });
});

describe('merge into a settings file with other keys and hooks (snapshot)', () => {
  it('matches the committed expected file, keeps every other key and hook', () => {
    const r = rig();
    r.go();
    const emitPath = join(r.dataDir, 'hooks', 'agent-office-emit.mjs');
    const after = readFileSync(r.settingsFile, 'utf8');
    const expected = readFileSync(join(FIX, 'settings-after.json'), 'utf8').replaceAll('__EMIT__', JSON.stringify(emitPath).slice(1, -1));
    expect(after).toBe(expected);
    const b = JSON.parse(BEFORE);
    const a = JSON.parse(after);
    for (const k of ['model', 'permissions', 'env', 'statusLine']) expect(a[k]).toEqual(b[k]);
    expect(a.hooks.PostCompact).toEqual(b.hooks.PostCompact);
    expect(a.hooks.Stop[0]).toEqual(b.hooks.Stop[0]);
    expect(a.hooks.PreToolUse[0]).toEqual(b.hooks.PreToolUse[0]);
    expect(Object.keys(a.hooks).length).toBe(Object.keys(HOOK_KIND).length + 1);
  });
});

describe('idempotence and backup', () => {
  it('second run changes nothing: identical file, no second backup, no new files', () => {
    const r = rig();
    const first = r.go({ now: Date.UTC(2026, 9, 24, 10, 15, 0) });
    expect(first.changed).toBe(true);
    const text = readFileSync(r.settingsFile, 'utf8');
    const files = tree(r.root);
    const second = r.go({ now: Date.UTC(2026, 9, 25, 1, 2, 3) });
    expect(second.changed).toBe(false);
    expect(second.backup).toBeNull();
    expect(readFileSync(r.settingsFile, 'utf8')).toBe(text);
    expect(tree(r.root)).toEqual(files);
  });

  it('the original is backed up once, timestamped, byte for byte, and never overwritten', () => {
    const r = rig();
    const a = r.go({ now: Date.UTC(2026, 9, 24, 10, 15, 0) });
    expect(a.backup).toBe(join(r.claudeDir, 'settings.json.agent-office.20261024T101500Z.bak'));
    expect(readFileSync(a.backup, 'utf8')).toBe(BEFORE);
    // The user edits the file, then uninstalls and installs again much later: the first backup stays the only one.
    r.go({ uninstall: true, now: Date.UTC(2027, 0, 1) });
    r.go({ now: Date.UTC(2027, 0, 2) });
    const baks = readdirSync(r.claudeDir).filter((f) => f.endsWith('.bak'));
    expect(baks).toEqual(['settings.json.agent-office.20261024T101500Z.bak']);
    expect(readFileSync(a.backup, 'utf8')).toBe(BEFORE);
  });

  it('backupOnce never overwrites an existing backup and skips a missing file', () => {
    const r = rig();
    expect(backupOnce(join(r.claudeDir, 'nope.json'))).toBeNull();
    const first = backupOnce(r.settingsFile, 1);
    writeFileSync(r.settingsFile, '{"changed":true}');
    expect(backupOnce(r.settingsFile, 2)).toBeNull();
    expect(readFileSync(first, 'utf8')).toBe(BEFORE);
  });

  it('stamp has no colons (legal Windows file name)', () => {
    expect(stamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('20260102T030405Z');
  });

  it('default settings path: <CLAUDE_CONFIG_DIR>/settings.json, else <home>/.claude/settings.json', () => {
    const r = rig({ settings: null });
    run({ target: 'user', emitBuilt: r.emitBuilt, env: r.env, withData: true, platform: 'linux' });
    expect(existsSync(r.settingsFile)).toBe(true);
    const alt = join(r.root, 'claude-cfg');
    run({ target: 'user', emitBuilt: r.emitBuilt, env: { ...r.env, CLAUDE_CONFIG_DIR: alt }, withData: false, platform: 'linux' });
    expect(existsSync(join(alt, 'settings.json'))).toBe(true);
  });

  it('no settings file yet: it is created, no backup', () => {
    const r = rig({ settings: null });
    const out = r.go();
    expect(out.backup).toBeNull();
    expect(Object.keys(JSON.parse(readFileSync(r.settingsFile, 'utf8')))).toEqual(['hooks']);
  });

  it('a moved data folder replaces our hooks instead of duplicating them', () => {
    const r = rig();
    r.go();
    const moved = join(r.root, 'elsewhere');
    run({ target: 'user', emitBuilt: r.emitBuilt, env: { HOME: r.home, AGENT_OFFICE_HOME: moved }, withData: true, platform: 'linux' });
    const s = JSON.parse(readFileSync(r.settingsFile, 'utf8'));
    const all = JSON.stringify(s);
    expect(all).not.toContain(r.dataDir);
    expect(all.match(/agent-office-emit\.mjs/g)).toHaveLength(Object.keys(HOOK_KIND).length);
  });
});

describe('refusals leave everything untouched', () => {
  it.each([
    ['invalid JSON', '{ "hooks": '],
    ['a JSON array', '[1,2]'],
    ['JSON null', 'null'],
    ['a JSON string', '"x"'],
    ['JSON with comments', '{ // c\n "a": 1 }'],
  ])('%s: throws, settings file byte-identical, nothing else created', (_n, content) => {
    const r = rig({ settings: content });
    expect(() => r.go()).toThrow(/not a valid JSON object.*nothing was changed/);
    expect(readFileSync(r.settingsFile, 'utf8')).toBe(content);
    expect(readdirSync(r.claudeDir)).toEqual(['settings.json']);
    expect(existsSync(r.dataDir)).toBe(false);
  });

  it('the same for --uninstall', () => {
    const r = rig({ settings: '{ nope' });
    expect(() => r.go({ uninstall: true })).toThrow(/not a valid JSON object/);
    expect(readFileSync(r.settingsFile, 'utf8')).toBe('{ nope');
  });

  it('a hooks value of the wrong shape is refused, not overwritten', () => {
    const r = rig({ settings: '{"hooks":{"Stop":"x"}}' });
    expect(() => r.go()).toThrow(/hooks\.Stop/);
    expect(readFileSync(r.settingsFile, 'utf8')).toBe('{"hooks":{"Stop":"x"}}');
    expect(existsSync(r.dataDir)).toBe(false);
  });

  it.each(['$HOME', '100%', 'a`b', 'a"b'])('an unsafe data folder name (%s) is refused with a clear message, nothing written', (bad) => {
    const r = rig();
    const dataDir = join(r.root, bad);
    expect(() => run({ target: 'user', emitBuilt: r.emitBuilt, env: { HOME: r.home, AGENT_OFFICE_HOME: dataDir }, withData: true, platform: 'linux' })).toThrow(/hook shell would expand/);
    expect(readFileSync(r.settingsFile, 'utf8')).toBe(BEFORE);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('a settings path that is a directory or a FIFO is refused without hanging', () => {
    const r = rig();
    const dirPath = join(r.root, 'asdir');
    mkdirSync(dirPath);
    expect(() => r.go({ settingsFile: dirPath })).toThrow(/regular file|cannot read/);
    if (process.platform !== 'win32') {
      const fifo = join(r.root, 'fifo');
      execFileSync('mkfifo', [fifo]);
      expect(() => r.go({ settingsFile: fifo })).toThrow(/regular file/);
    }
  });
});

describe('--dry-run', () => {
  it('prints a diff summary and writes nothing at all (no data folder, token, config, copy, backup)', () => {
    const r = rig();
    const before = tree(r.root);
    const out = r.go({ dryRun: true });
    expect(tree(r.root)).toEqual(before);
    expect(existsSync(r.dataDir)).toBe(false);
    expect(readFileSync(r.settingsFile, 'utf8')).toBe(BEFORE);
    expect(out.lines).toContain('dry run: nothing was written');
    expect(out.lines.filter((l) => l.startsWith('  + '))).toHaveLength(Object.keys(HOOK_KIND).length);
    expect(out.lines.join('\n')).toMatch(/token: will be created/);
    expect(out.lines.join('\n')).toMatch(/config: will be created/);
  });

  it('after an install it reports up to date', () => {
    const r = rig();
    r.go();
    expect(r.go({ dryRun: true }).lines).toContain('hooks: already up to date');
  });
});

describe('--uninstall', () => {
  it('removes only our hooks and restores the original content; keeps token, config and the script copy', () => {
    const r = rig();
    r.go();
    const out = r.go({ uninstall: true });
    expect(out.changed).toBe(true);
    expect(JSON.parse(readFileSync(r.settingsFile, 'utf8'))).toEqual(JSON.parse(BEFORE));
    expect(existsSync(join(r.dataDir, 'local-token'))).toBe(true);
    expect(existsSync(join(r.dataDir, 'config.json'))).toBe(true);
    expect(existsSync(join(r.dataDir, 'hooks', 'agent-office-emit.mjs'))).toBe(true);
    expect(r.go({ uninstall: true }).changed).toBe(false);
  });

  it('uninstall without a prior install, and without a settings file, changes and creates nothing', () => {
    const r = rig({ settings: null });
    const before = tree(r.root);
    expect(r.go({ uninstall: true }).changed).toBe(false);
    expect(tree(r.root)).toEqual(before);
  });

  it('dry-run uninstall writes nothing', () => {
    const r = rig();
    r.go();
    const before = tree(r.root);
    const out = r.go({ uninstall: true, dryRun: true });
    expect(tree(r.root)).toEqual(before);
    expect(out.lines.filter((l) => l.startsWith('  - ')).length).toBe(Object.keys(HOOK_KIND).length);
  });
});

describe('no secret in any written file', () => {
  it('the token lives only in local-token (0600); settings, config, copy and backup never hold it', () => {
    const r = rig();
    r.go();
    const token = readFileSync(join(r.dataDir, 'local-token'), 'utf8').trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const all = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else all.push(p);
      }
    };
    walk(r.root);
    for (const f of all.filter((p) => !p.endsWith('local-token'))) expect(readFileSync(f, 'utf8'), f).not.toContain(token);
    expect(all.filter((p) => readFileSync(p, 'utf8').includes(token))).toEqual([join(r.dataDir, 'local-token')]);
    if (process.platform !== 'win32') expect(statSync(join(r.dataDir, 'local-token')).mode & 0o777).toBe(0o600);
    // and the output of the run never shows it
    const out = r.go();
    expect(out.lines.join('\n')).not.toContain(token);
  });
});

describe('token and config.json', () => {
  it('an existing valid token is kept byte for byte', () => {
    const r = rig();
    mkdirSync(r.dataDir, { recursive: true });
    const tok = `${'a1B2'.repeat(10)}xyz\n`;
    writeFileSync(join(r.dataDir, 'local-token'), tok);
    r.go();
    expect(readFileSync(join(r.dataDir, 'local-token'), 'utf8')).toBe(tok);
  });

  it('a malformed token is never overwritten: error, and the settings file stays untouched', () => {
    const r = rig();
    mkdirSync(r.dataDir, { recursive: true });
    writeFileSync(join(r.dataDir, 'local-token'), 'short!');
    expect(() => r.go()).toThrow(/local-token.*does not hold a valid token/);
    expect(readFileSync(join(r.dataDir, 'local-token'), 'utf8')).toBe('short!');
    expect(readFileSync(r.settingsFile, 'utf8')).toBe(BEFORE);
  });

  it.runIf(process.platform !== 'win32')('a dangling local-token symlink is an error: nothing written, link untouched', () => {
    const r = rig();
    mkdirSync(r.dataDir, { recursive: true });
    const link = join(r.dataDir, 'local-token');
    symlinkSync(join(r.root, 'nowhere'), link);
    expect(() => r.go()).toThrow(/local-token.*cannot be read/);
    expect(() => r.go({ dryRun: true })).toThrow(/local-token.*cannot be read/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(r.root, 'nowhere'))).toBe(false);
    expect(readFileSync(r.settingsFile, 'utf8')).toBe(BEFORE);
    expect(existsSync(join(r.dataDir, 'hooks'))).toBe(false);
  });

  it('config.json is created with the default port', () => {
    const r = rig();
    r.go();
    expect(JSON.parse(readFileSync(join(r.dataDir, 'config.json'), 'utf8'))).toEqual({ port: 47821 });
  });

  it('Windows: claudePath defaults to %USERPROFILE%\\.local\\bin\\claude.exe only when that file exists', () => {
    const r = rig();
    const exe = 'C:\\Users\\po\\.local\\bin\\claude.exe';
    const env = { ...r.env, USERPROFILE: 'C:\\Users\\po' };
    r.go({ env, platform: 'win32', fileExists: (p) => p === exe });
    expect(JSON.parse(readFileSync(join(r.dataDir, 'config.json'), 'utf8'))).toEqual({ port: 47821, claudePath: exe });
  });

  it('Windows, claude.exe missing: claudePath omitted, clear warning with the path tried, never invented', () => {
    const r = rig();
    const env = { ...r.env, USERPROFILE: 'C:\\Users\\po' };
    const out = r.go({ env, platform: 'win32', fileExists: () => false });
    expect(JSON.parse(readFileSync(join(r.dataDir, 'config.json'), 'utf8'))).toEqual({ port: 47821 });
    expect(out.lines.find((l) => l.startsWith('warning:'))).toMatch(/claude\.exe not found at C:\\Users\\po\\\.local\\bin\\claude\.exe.*claudePath/);
  });

  it('not Windows: claudePath omitted with a note', () => {
    const r = rig();
    const out = r.go({ platform: 'linux', fileExists: () => true });
    expect(JSON.parse(readFileSync(join(r.dataDir, 'config.json'), 'utf8'))).toEqual({ port: 47821 });
    expect(out.lines.some((l) => l.startsWith('warning: claudePath not set'))).toBe(true);
  });

  it('an existing config.json keeps its keys (port, claudePath, unknown), and a second run does not rewrite it', () => {
    const r = rig();
    mkdirSync(r.dataDir, { recursive: true });
    const cfg = '{\n    "port": 50123,\n    "claudePath": "C:\\\\x\\\\claude.exe",\n    "relayUrl": "https://r.example"\n}\n';
    writeFileSync(join(r.dataDir, 'config.json'), cfg);
    r.go({ env: { ...r.env, USERPROFILE: 'C:\\Users\\po' }, platform: 'win32', fileExists: () => true });
    expect(readFileSync(join(r.dataDir, 'config.json'), 'utf8')).toBe(cfg);
  });

  it('an existing config.json missing only claudePath gets it added, other keys and 4-space indent kept', () => {
    const r = rig();
    mkdirSync(r.dataDir, { recursive: true });
    writeFileSync(join(r.dataDir, 'config.json'), '{\n    "port": 50123,\n    "relayUrl": "https://r.example"\n}\n');
    r.go({ env: { ...r.env, USERPROFILE: 'C:\\Users\\po' }, platform: 'win32', fileExists: () => true });
    expect(readFileSync(join(r.dataDir, 'config.json'), 'utf8')).toBe(
      '{\n    "port": 50123,\n    "relayUrl": "https://r.example",\n    "claudePath": "C:\\\\Users\\\\po\\\\.local\\\\bin\\\\claude.exe"\n}\n',
    );
  });

  it('an invalid config.json is never overwritten: error and nothing else written', () => {
    const r = rig();
    mkdirSync(r.dataDir, { recursive: true });
    writeFileSync(join(r.dataDir, 'config.json'), '{ nope');
    expect(() => r.go()).toThrow(/config\.json is not a valid JSON object/);
    expect(readFileSync(join(r.dataDir, 'config.json'), 'utf8')).toBe('{ nope');
    expect(readFileSync(r.settingsFile, 'utf8')).toBe(BEFORE);
    expect(existsSync(join(r.dataDir, 'local-token'))).toBe(false);
  });
});

describe('file details', () => {
  it('copies the built emit script to <data>/hooks/agent-office-emit.mjs, replacing an older copy', () => {
    const r = rig();
    r.go();
    const dest = join(r.dataDir, 'hooks', 'agent-office-emit.mjs');
    expect(readFileSync(dest, 'utf8')).toBe('// built emit\n');
    writeFileSync(r.emitBuilt, '// newer\n');
    r.go();
    expect(readFileSync(dest, 'utf8')).toBe('// newer\n');
    expect(readdirSync(join(r.dataDir, 'hooks'))).toEqual(['agent-office-emit.mjs']);
  });

  it('keeps the file indentation (tabs) and CRLF line endings', () => {
    const r = rig({ settings: '{\r\n\t"model": "x"\r\n}\r\n' });
    r.go();
    const t = readFileSync(r.settingsFile, 'utf8');
    expect(t.startsWith('{\r\n\t"model": "x",\r\n\t"hooks": {')).toBe(true);
    expect(t.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('accepts a UTF-8 BOM (PowerShell 5 writes one)', () => {
    const r = rig({ settings: '\uFEFF{"model":"x"}' });
    r.go();
    expect(JSON.parse(readFileSync(r.settingsFile, 'utf8').slice(1)).model).toBe('x');
  });

  it.each(['', '  \r\n\t\n'])('an empty or whitespace-only settings.json counts as {} (backup kept): %j', (empty) => {
    const r = rig({ settings: empty });
    r.go();
    expect(JSON.parse(readFileSync(r.settingsFile, 'utf8')).hooks.Stop).toHaveLength(1);
    const baks = readdirSync(r.claudeDir).filter((f) => f.endsWith('.bak'));
    expect(baks).toHaveLength(1);
    expect(readFileSync(join(r.claudeDir, baks[0]), 'utf8')).toBe(empty);
  });

  it('keeps a BOM when the original had one, adds none otherwise, and re-runs are byte for byte', () => {
    const withBom = rig({ settings: '\uFEFF{"model":"x"}' });
    withBom.go();
    const a = readFileSync(withBom.settingsFile, 'utf8');
    expect(a.charCodeAt(0)).toBe(0xfeff);
    expect(a.charCodeAt(1)).not.toBe(0xfeff);
    withBom.go();
    expect(readFileSync(withBom.settingsFile, 'utf8')).toBe(a);
    const plain = rig({ settings: '{"model":"x"}' });
    plain.go();
    expect(readFileSync(plain.settingsFile, 'utf8').charCodeAt(0)).toBe(0x7b);
  });

  it.runIf(process.platform !== 'win32')('a symlinked settings.json stays a symlink and its target is updated', () => {
    const r = rig({ settings: null });
    const real = join(r.root, 'real-settings.json');
    writeFileSync(real, '{"model":"x"}');
    symlinkSync(real, r.settingsFile);
    r.go();
    expect(lstatSync(r.settingsFile).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).hooks.Stop).toHaveLength(1);
  });

  it('leaves no temp files behind', () => {
    const r = rig();
    r.go();
    expect(tree(r.root).filter((f) => f.includes('agent-office-tmp'))).toEqual([]);
  });
});

describe('repo target', () => {
  function repoRig() {
    const r = rig();
    const repo = join(r.root, 'some repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"env":{"A":"1"}}');
    return { ...r, repo };
  }

  it('installs the ${CLAUDE_PROJECT_DIR} template, keeps repo settings, no backup file, idempotent', () => {
    const r = repoRig();
    const go = (o = {}) => run({ target: 'repo', repo: r.repo, emitBuilt: r.emitBuilt, env: r.env, ...o });
    go();
    const s = JSON.parse(readFileSync(join(r.repo, '.claude', 'settings.json'), 'utf8'));
    expect(s.env).toEqual({ A: '1' });
    expect(s.hooks.Stop[0].hooks[0].args[0]).toBe('${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-office-emit.mjs');
    expect(readdirSync(join(r.repo, '.claude')).sort()).toEqual(['hooks', 'settings.json']);
    expect(go().changed).toBe(false);
    expect(existsSync(r.dataDir)).toBe(false); // repo mode never touches the data folder
  });

  it('uninstall removes our hooks and the repo copy (a leftover copy would make the user hook step aside)', () => {
    const r = repoRig();
    const go = (o = {}) => run({ target: 'repo', repo: r.repo, emitBuilt: r.emitBuilt, env: r.env, ...o });
    go();
    go({ uninstall: true });
    expect(JSON.parse(readFileSync(join(r.repo, '.claude', 'settings.json'), 'utf8'))).toEqual({ env: { A: '1' } });
    expect(existsSync(join(r.repo, '.claude', 'hooks'))).toBe(false);
  });
});
