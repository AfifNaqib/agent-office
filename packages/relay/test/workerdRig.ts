// Starts `wrangler dev` (local workerd + the SQLite Durable Object) for the workerd
// tests. No Cloudflare account and no network needed.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const relayDir = join(here, '..');
const wranglerJs = join(relayDir, '..', '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
export const skipWorkerd = process.env.AGENT_OFFICE_SKIP_WORKERD === '1';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => {
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
  });
}

async function waitUp(base: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output()}`);
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      // Behind Access since V1-02: a 401 without a JWT means the Worker is up.
      if (res.status === 401) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`wrangler dev did not start:\n${output()}`);
}

export function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = setTimeout(() => {
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        // already gone
      }
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(done);
      resolve();
    });
    try {
      process.kill(-(child.pid ?? 0), 'SIGTERM');
    } catch {
      clearTimeout(done);
      resolve();
    }
  });
}

export interface Wrangler {
  readonly base: string;
  readonly persist: string;
  readonly child: ChildProcess;
  output(): string;
  stop(): Promise<void>;
  /** Stops wrangler and deletes the persist folder. */
  dispose(): Promise<void>;
}

/**
 * `wrangler dev` with the given extra args (e.g. `--config test/workerd/wrangler.jsonc`)
 * and vars, on a free loopback port, persisting into a fresh temp folder.
 */
export async function startWrangler(extraArgs: readonly string[], vars: Record<string, string>): Promise<Wrangler> {
  const persist = mkdtempSync(join(tmpdir(), 'ao-relay-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
  const child = spawn(
    process.execPath,
    [wranglerJs, 'dev', ...extraArgs, '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist, '--show-interactive-dev-session=false', ...varArgs],
    { cwd: relayDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } },
  );
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const w: Wrangler = {
    base,
    persist,
    child,
    output: () => out,
    stop: () => stopChild(child),
    dispose: async () => {
      await stopChild(child);
      rmSync(persist, { recursive: true, force: true });
    },
  };
  try {
    await waitUp(base, child, () => out);
  } catch (err) {
    await w.dispose();
    throw err;
  }
  return w;
}
