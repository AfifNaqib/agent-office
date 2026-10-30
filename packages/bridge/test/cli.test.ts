// `npm run bridge` end to end: the bundled bridge process, plus the bundled emit script talking to it.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OfficeEvent } from '@agent-office/core';
import { TOKEN, call, getJson, post, makeEvent, sleep, tempDir } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const BUNDLE = join(PKG, 'dist', 'agent-office-bridge.mjs');
const EMIT_PKG = join(PKG, '..', 'emit');
const EMIT = join(EMIT_PKG, 'dist', 'agent-office-emit.mjs');
const FIXTURES = join(PKG, '..', '..', 'fixtures', 'hooks');

beforeAll(() => {
  execFileSync(process.execPath, [join(PKG, 'build.mjs')], { stdio: 'pipe' });
  execFileSync(process.execPath, [join(EMIT_PKG, 'build.mjs')], { stdio: 'pipe' });
}, 60_000);

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => {
        resolve(port);
      });
    });
  });
}

interface Proc {
  readonly child: ChildProcess;
  readonly out: () => string;
  readonly err: () => string;
  readonly exited: Promise<number | null>;
}

function startBridgeProcess(env: Record<string, string>): Proc {
  const child = spawn(process.execPath, [BUNDLE], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr.on('data', (c: Buffer) => (err += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  return { child, out: () => out, err: () => err, exited };
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(25);
  }
}

describe('npm run bridge (bundled process)', () => {
  it('starts on the configured port, creates the token, serves, and stops cleanly on SIGTERM; the token is never printed', async () => {
    const home = tempDir();
    const port = await freePort();
    const p = startBridgeProcess({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_BRIDGE_PORT: String(port) });
    await until(() => p.out().includes('listening on'));
    expect(p.out()).toContain(`http://127.0.0.1:${port}`);
    const token = readFileSync(join(home, 'local-token'), 'utf8').trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await post(port, makeEvent(1), { token })).status).toBe(204);
    expect((await post(port, makeEvent(2), { token: TOKEN })).status).toBe(401);
    expect((JSON.parse((await call(port, '/api/events', { token })).body) as { events: unknown[] }).events).toHaveLength(1);
    p.child.kill('SIGTERM');
    expect(await p.exited).toBe(0);
    expect(p.out() + p.err()).not.toContain(token);
    // Nor any other token-shaped line (the bundled gen-token once printed a stray one).
    expect(p.out() + p.err()).not.toMatch(/^[A-Za-z0-9_-]{43}$/m);
    expect(readdirSync(join(home, 'events'))).toHaveLength(1);
  }, 30_000);

  it('B-08: every stdout/stderr line of the built bridge is an info/warn/event log line, none looks like a token', async () => {
    const home = tempDir();
    const port = await freePort();
    const p = startBridgeProcess({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_BRIDGE_PORT: String(port) });
    await until(() => p.out().includes('listening on'));
    const token = readFileSync(join(home, 'local-token'), 'utf8').trim();
    expect((await post(port, makeEvent(1), { token })).status).toBe(204);
    await sleep(100);
    p.child.kill('SIGTERM');
    await p.exited;
    const lines = (p.out() + p.err()).split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l, l).toMatch(/^(info|warn|event) /);
      expect(l, l).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    }
  }, 30_000);

  it('the built emit script delivers real hook payloads to the bridge (token file, headers, ids, nonce) and the bridge stores them', async () => {
    const home = tempDir();
    const port = await freePort();
    const p = startBridgeProcess({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_BRIDGE_PORT: String(port) });
    await until(() => p.out().includes('listening on'));
    const files = readdirSync(join(FIXTURES, 'pc-desktop')).filter((f) => f.endsWith('.json')).sort();
    let sent = 0;
    for (const f of files) {
      const doc = JSON.parse(readFileSync(join(FIXTURES, 'pc-desktop', f), 'utf8')) as { payload: unknown };
      await new Promise<void>((resolve, reject) => {
        const c = spawn(process.execPath, [EMIT], { env: { PATH: process.env.PATH ?? '', AGENT_OFFICE_HOME: home, AGENT_OFFICE_BRIDGE_PORT: String(port) }, stdio: ['pipe', 'ignore', 'ignore'] });
        c.on('error', reject);
        c.on('close', () => {
          resolve();
        });
        c.stdin.end(JSON.stringify(doc.payload));
      });
      sent += 1;
    }
    const token = readFileSync(join(home, 'local-token'), 'utf8').trim();
    const page = JSON.parse((await call(port, '/api/events?limit=500', { token })).body) as { events: { event: OfficeEvent }[] };
    expect(sent).toBeGreaterThan(20);
    // exec and shell forms of one hook are the same payload (same id): the bridge stored each once.
    expect(page.events.length).toBeGreaterThan(10);
    expect(page.events.length).toBeLessThanOrEqual(sent);
    expect(new Set(page.events.map((e) => e.event.id)).size).toBe(page.events.length);
    expect(page.events.every((e) => typeof e.event.receivedAt === 'number' && Math.abs((e.event.receivedAt ?? 0) - Date.now()) < 60_000)).toBe(true);
    expect(page.events.some((e) => e.event.kind === 'permission.request')).toBe(true);
    const sessions = await getJson<unknown>(port, '/api/health');
    expect(sessions).toBeTruthy();
    p.child.kill('SIGTERM');
    await p.exited;
  }, 60_000);

  it('B-07: with the port ONLY in config.json (no env var), the built bridge listens there and the built emit script finds it', async () => {
    const home = tempDir();
    const port = await freePort();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ port }));
    const p = startBridgeProcess({ AGENT_OFFICE_HOME: home });
    await until(() => p.out().includes('listening on'));
    expect(p.out()).toContain(`http://127.0.0.1:${port}`);
    const doc = JSON.parse(readFileSync(join(FIXTURES, 'pc2', '001-SessionStart-exec.json'), 'utf8')) as { payload: unknown };
    await new Promise<void>((resolve, reject) => {
      const c = spawn(process.execPath, [EMIT], { env: { PATH: process.env.PATH ?? '', AGENT_OFFICE_HOME: home }, stdio: ['pipe', 'ignore', 'ignore'] });
      c.on('error', reject);
      c.on('close', () => {
        resolve();
      });
      c.stdin.end(JSON.stringify(doc.payload));
    });
    const token = readFileSync(join(home, 'local-token'), 'utf8').trim();
    await until(() => p.out().includes('event session.start') || p.out().includes('event '));
    const page = JSON.parse((await call(port, '/api/events', { token })).body) as { events: unknown[] };
    expect(page.events).toHaveLength(1);
    p.child.kill('SIGTERM');
    await p.exited;
  }, 30_000);

  it('port already in use -> exit 1 with a readable message', async () => {
    const home = tempDir();
    const port = await freePort();
    const blocker = createServer().listen(port, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    try {
      const p = startBridgeProcess({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_BRIDGE_PORT: String(port) });
      expect(await p.exited).toBe(1);
      expect(p.err()).toContain(`port ${port} is already in use`);
    } finally {
      blocker.close();
    }
  }, 30_000);

  it('a broken token file -> exit 1, message names the file, never the content', async () => {
    const home = tempDir();
    writeFileSync(join(home, 'local-token'), 'short!');
    const p = startBridgeProcess({ AGENT_OFFICE_HOME: home, AGENT_OFFICE_BRIDGE_PORT: String(await freePort()) });
    expect(await p.exited).toBe(1);
    expect(p.err()).toContain('local-token');
    expect(p.err()).not.toContain('short!');
  }, 30_000);
});
