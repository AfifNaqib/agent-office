// End to end on Linux with temp dirs: `setup:pc` -> built bridge -> the hook command exactly as the
// merged settings.json spells it (exec form) -> the event arrives. Windows itself is not covered.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildBridge, OUTFILE as BRIDGE } from '../../packages/bridge/build.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SETUP = join(REPO, 'scripts', 'setup-pc.mjs');
const INSTALL = join(REPO, 'scripts', 'install-hooks.mjs');
const FIXTURE = join(REPO, 'fixtures', 'hooks', 'pc2', '001-SessionStart-exec.json');

beforeAll(async () => {
  await buildBridge();
}, 60_000);

const children = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'ao-e2e-'));
  const home = join(root, 'home');
  const dataDir = join(root, 'data dir');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const env = { PATH: process.env.PATH ?? '', HOME: home, AGENT_OFFICE_HOME: dataDir };
  const settings = join(home, '.claude', 'settings.json');
  return { root, home, dataDir, env, settings };
}
const node = (script, args, env) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 60_000 });

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => {
        resolve(port);
      });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('setup:pc CLI', () => {
  it('first run installs, second run changes nothing, the token is never printed', () => {
    const r = rig();
    writeFileSync(r.settings, '{"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo"}]}]}}');
    const a = node(SETUP, [], r.env);
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toContain('hooks installed');
    expect(a.stdout).toContain('next: npm run bridge');
    const token = readFileSync(join(r.dataDir, 'local-token'), 'utf8').trim();
    expect(a.stdout + a.stderr).not.toContain(token);
    const text = readFileSync(r.settings, 'utf8');
    const copy = readFileSync(join(r.dataDir, 'hooks', 'agent-office-emit.mjs'), 'utf8');
    const b = node(SETUP, [], r.env);
    expect(b.status, b.stderr).toBe(0);
    expect(b.stdout).toContain('hooks: already up to date');
    expect(b.stdout).toContain('nothing to change');
    expect(readFileSync(r.settings, 'utf8')).toBe(text);
    expect(readFileSync(join(r.dataDir, 'local-token'), 'utf8').trim()).toBe(token);
    expect(readFileSync(join(r.dataDir, 'hooks', 'agent-office-emit.mjs'), 'utf8')).toBe(copy);
    expect(readdirSync(join(r.home, '.claude')).filter((f) => f.endsWith('.bak'))).toHaveLength(1);
    expect(copy).not.toContain(token);
  }, 90_000);

  it('invalid JSON: exit 1, readable message on stderr, file untouched, no data folder', () => {
    const r = rig();
    writeFileSync(r.settings, '{ broken');
    const a = node(SETUP, [], r.env);
    expect(a.status).toBe(1);
    expect(a.stderr).toMatch(/^setup:pc: .*settings\.json is not a valid JSON object.*nothing was changed/);
    expect(a.stdout).toBe('');
    expect(readFileSync(r.settings, 'utf8')).toBe('{ broken');
    expect(existsSync(r.dataDir)).toBe(false);
  }, 60_000);

  it('--dry-run writes nothing and says so; --uninstall removes only our hooks', () => {
    const r = rig();
    const orig = '{"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo"}]}]}}';
    writeFileSync(r.settings, orig);
    const d = node(SETUP, ['--dry-run'], r.env);
    expect(d.status, d.stderr).toBe(0);
    expect(d.stdout).toContain('dry run: nothing was written');
    expect(d.stdout).not.toContain('next: npm run bridge');
    expect(readFileSync(r.settings, 'utf8')).toBe(orig);
    expect(existsSync(r.dataDir)).toBe(false);
    expect(readdirSync(join(r.home, '.claude'))).toEqual(['settings.json']);

    expect(node(SETUP, [], r.env).status).toBe(0);
    const u = node(SETUP, ['--uninstall'], r.env);
    expect(u.status, u.stderr).toBe(0);
    expect(u.stdout).toContain('hooks removed');
    expect(JSON.parse(readFileSync(r.settings, 'utf8'))).toEqual(JSON.parse(orig));
    expect(existsSync(join(r.dataDir, 'local-token'))).toBe(true);
  }, 90_000);

  it('--settings <file> targets that file instead of ~/.claude/settings.json', () => {
    const r = rig();
    const alt = join(r.root, 'alt.json');
    writeFileSync(alt, '{}');
    expect(node(SETUP, ['--settings', alt], r.env).status).toBe(0);
    expect(JSON.parse(readFileSync(alt, 'utf8')).hooks.Stop).toHaveLength(1);
    expect(existsSync(r.settings)).toBe(false);
  }, 60_000);

  it('bad arguments: exit 1 with usage', () => {
    const r = rig();
    for (const args of [['--nope'], ['--settings'], ['somerepo'], ['--settings', '--dry-run']]) {
      const a = node(SETUP, args, r.env);
      expect(a.status, args.join(' ')).toBe(1);
      expect(a.stderr).toContain('usage: install-hooks.mjs');
    }
    expect(existsSync(r.dataDir)).toBe(false);
  }, 60_000);

  it('an unsafe AGENT_OFFICE_HOME is refused with a clear message', () => {
    const r = rig();
    const a = node(SETUP, [], { ...r.env, AGENT_OFFICE_HOME: join(r.root, 'a$b') });
    expect(a.status).toBe(1);
    expect(a.stderr).toMatch(/hook shell would expand/);
    expect(existsSync(join(r.root, 'a$b'))).toBe(false);
  }, 60_000);
});

describe('install-hooks CLI', () => {
  it('user hooks only: no token, no config.json', () => {
    const r = rig();
    const a = node(INSTALL, [], r.env);
    expect(a.status, a.stderr).toBe(0);
    expect(readdirSync(r.dataDir)).toEqual(['hooks']);
    expect(JSON.parse(readFileSync(r.settings, 'utf8')).hooks.PermissionRequest).toHaveLength(1);
  }, 60_000);

  it('a repo path that is not a git repository is refused', () => {
    const r = rig();
    const a = node(INSTALL, [r.root], r.env);
    expect(a.status).toBe(1);
    expect(a.stderr).toContain('is not a git repository');
  }, 60_000);
});

describe('whole chain on Linux temp dirs', () => {
  it('setup:pc -> built bridge on the config.json port -> the settings.json hook command runs the user copy -> the event arrives', async () => {
    const r = rig();
    expect(node(SETUP, [], r.env).status).toBe(0);

    // Non-default port through config.json ONLY (B-07): no AGENT_OFFICE_BRIDGE_PORT anywhere.
    const port = await freePort();
    const cfgFile = join(r.dataDir, 'config.json');
    writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, 'utf8')), port }));

    const bridge = spawn(process.execPath, [BRIDGE], { env: r.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(bridge);
    let out = '';
    bridge.stdout.on('data', (c) => (out += c.toString()));
    for (let i = 0; i < 200 && !out.includes('listening on'); i += 1) await sleep(25);
    expect(out).toContain(`http://127.0.0.1:${port}`);

    // Run the hook exactly as Claude Code would: command + args from the merged file, payload on stdin.
    const hook = JSON.parse(readFileSync(r.settings, 'utf8')).hooks.SessionStart[0].hooks[0];
    expect(hook.command).toBe('node');
    expect(hook.args).toEqual([join(r.dataDir, 'hooks', 'agent-office-emit.mjs')]);
    const payload = JSON.stringify(JSON.parse(readFileSync(FIXTURE, 'utf8')).payload);
    const hookRun = spawnSync(process.execPath, hook.args, { input: payload, env: r.env, encoding: 'utf8', timeout: 20_000 });
    expect(hookRun.status).toBe(0);
    expect(hookRun.stdout).toBe('');
    expect(hookRun.stderr).toBe('');

    const token = readFileSync(join(r.dataDir, 'local-token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { 'X-Agent-Office-Local': token } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].event.kind).toBe('session.start');
    expect(body.events[0].event.source).toBe('local');
  }, 90_000);
});
