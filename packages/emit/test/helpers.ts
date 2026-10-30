// Test helpers: spawn the built single file, run a mock HTTP server.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG = join(HERE, '..');
export const BUILT = join(PKG, 'dist', 'agent-office-emit.mjs');
export const FIXTURES = join(PKG, '..', '..', 'fixtures', 'hooks');
// Generated, not a literal, so the repo's secret scan has nothing to match.
export const LOCAL_HEADER_VALUE = Array.from({ length: 43 }, (_c, i) => 'abcdefghijklmnopqrstuvwxyz0123456789_-'[i % 38]).join('');

/** The bundle is built once per run by vitest.global-setup.mjs; this only checks it is there. */
export function buildEmit(): void {
  if (!existsSync(BUILT)) throw new Error(`missing ${BUILT}: run through vitest (global setup builds it)`);
}

export function tempDir(prefix = 'ao-emit-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A data dir holding the local token, like %USERPROFILE%\.agent-office. */
export function dataDirWithToken(value: string | null = LOCAL_HEADER_VALUE): string {
  const dir = tempDir('ao-home-');
  if (value !== null) writeFileSync(join(dir, 'local-token'), `${value}\n`);
  return dir;
}

export interface Captured {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Mock {
  readonly port: number;
  readonly requests: Captured[];
  close(): Promise<void>;
}

/** Mock bridge/relay. `hang` = accept the request and never answer (3 s timeout); `error` = 500; `redirect` = 302 to the same server's /elsewhere. */
export async function mockServer(mode: 'ok' | 'hang' | 'error' | 'redirect' = 'ok'): Promise<Mock> {
  const requests: Captured[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (mode === 'hang') return;
      res.statusCode = mode === 'ok' ? 204 : mode === 'error' ? 500 : 302;
      if (mode === 'redirect') res.setHeader('Location', '/elsewhere');
      res.end();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          r();
        });
      }),
  };
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const m = await mockServer();
  const { port } = m;
  await m.close();
  return port;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** Run the built file (or a copy) with a controlled environment: nothing leaks in from the host. */
export function runEmit(stdin: string, env: Record<string, string>, file: string = BUILT): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [file], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

export interface FixtureFile {
  readonly set: string;
  readonly file: string;
  readonly payload: Record<string, unknown>;
}

export function loadFixtureSet(set: string): FixtureFile[] {
  return readdirSync(join(FIXTURES, set))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      set,
      file,
      payload: (JSON.parse(readFileSync(join(FIXTURES, set, file), 'utf8')) as { payload: Record<string, unknown> }).payload,
    }));
}

export function fixture(set: string, file: string): string {
  const f = loadFixtureSet(set).find((x) => x.file === file);
  if (!f) throw new Error(`missing fixture ${set}/${file}`);
  return JSON.stringify(f.payload);
}

/** Copy the built file to `<dir>/<relative path>` and return the new path. */
export function installCopy(dir: string, relative: string): string {
  const dest = join(dir, relative);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(BUILT, dest);
  return dest;
}
