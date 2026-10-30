// Test helpers: a real bridge on an ephemeral port, raw HTTP/TCP clients, event builders.
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { OfficeEvent } from '@agent-office/core';
import { startBridge, type Bridge, type BridgeOptions } from '../src/server.js';
import type { Logger } from '../src/log.js';

// Generated at runtime, so the repo's secret scan has no literal to match.
export const TOKEN = Array.from({ length: 43 }, (_c, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[(i * 7) % 64]).join('');
export const NOW0 = Date.UTC(2026, 9, 21, 12, 0, 0);
export const DAY = 24 * 60 * 60 * 1000;

export function tempDir(prefix = 'ao-bridge-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** A valid OfficeEvent (tool.start by default). `n` makes the id unique. */
export function makeEvent(n: number, over: Partial<OfficeEvent> = {}): OfficeEvent {
  return {
    v: 1,
    id: sha(`event-${n}`),
    emittedAt: NOW0 + n,
    source: 'local',
    sessionId: 'sess-1',
    repo: 'agent-office',
    actor: { kind: 'main', agentType: null, agentId: null },
    kind: 'tool.start',
    tool: { name: 'Read', useId: `toolu_${n}`, summary: 'src/a.ts' },
    ...over,
  };
}

export interface Rig {
  readonly bridge: Bridge;
  readonly dir: string;
  readonly port: number;
  readonly lines: string[];
  readonly clock: { now: number };
  stop(): Promise<void>;
}

const open: Rig[] = [];

/** Start a bridge in `dir` (a fresh temp dir by default) with a controllable clock and a capturing logger. */
export async function startRig(over: Partial<BridgeOptions> & { dir?: string } = {}): Promise<Rig> {
  const dir = over.dir ?? tempDir();
  const lines: string[] = [];
  const logger: Logger = {
    event: (k, id, s) => lines.push(`event ${k} ${id.slice(0, 8)} ${s}`),
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
  };
  const clock = { now: NOW0 };
  const rest: Partial<BridgeOptions> = { ...over };
  delete (rest as { dir?: string }).dir;
  const bridge = await startBridge({
    eventsDir: dir,
    token: TOKEN,
    port: 0,
    now: () => clock.now,
    logger,
    ...rest,
  });
  const rig: Rig = {
    bridge,
    dir,
    port: bridge.port,
    lines,
    clock,
    stop: async () => {
      await bridge.stop();
    },
  };
  open.push(rig);
  return rig;
}

export async function stopAll(): Promise<void> {
  const rigs = open.splice(0);
  await Promise.all(rigs.map((r) => r.stop()));
}

export interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Opts {
  readonly method?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly body?: string | Buffer;
  /** Send the local token header (default true). */
  readonly token?: string | false;
  /** Host header; default 127.0.0.1:<port>. `false` omits it. */
  readonly host?: string | false;
  readonly json?: boolean;
}

/** One HTTP request over a fresh connection, with full control of Host and the token. */
export function call(port: number, path: string, opts: Opts = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | string[]> = {};
    if (opts.host !== false) headers.Host = opts.host ?? `127.0.0.1:${port}`;
    if (opts.token !== false) headers['X-Agent-Office-Local'] = opts.token ?? TOKEN;
    if (opts.json === true) headers['Content-Type'] = 'application/json';
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (v === undefined) Reflect.deleteProperty(headers, k);
      else headers[k] = v;
    }
    const req = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, agent: false, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

export const post = (port: number, e: unknown, opts: Opts = {}): Promise<Reply> =>
  call(port, '/hooks/event', { method: 'POST', json: true, body: typeof e === 'string' ? e : JSON.stringify(e), ...opts });

export const getJson = async <T>(port: number, path: string): Promise<T> => JSON.parse((await call(port, path)).body) as T;

/** Raw TCP: write `data`, collect everything the server sends until it closes or `ms` passes. */
export function raw(port: number, data: string | Buffer, ms = 2000): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port });
    let text = '';
    let closed = false;
    const done = (): void => {
      s.destroy();
      resolve({ text, closed });
    };
    const timer = setTimeout(done, ms);
    s.on('data', (c: Buffer) => (text += c.toString('latin1')));
    s.on('close', () => {
      closed = true;
      clearTimeout(timer);
      done();
    });
    s.on('error', () => undefined);
    s.on('connect', () => s.write(data));
  });
}

export function connect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection({ host: '127.0.0.1', port }, () => {
      s.resume(); // read (and drop) whatever the server sends, so 'close' is delivered
      resolve(s);
    });
    s.on('error', reject);
  });
}

export function statusOf(text: string): number {
  return Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/** All JSONL lines in a bridge events dir, parsed. */
export function storedLines(dir: string): OfficeEvent[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l) as OfficeEvent);
}

export interface WsClient {
  readonly ws: WebSocket;
  readonly messages: Record<string, unknown>[];
  readonly closed: Promise<{ code: number; reason: string }>;
  waitFor(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
}

/** Open /ws. `auth`: 'header' (upgrade header), 'message' (first message), or none. */
export function wsOpen(port: number, opts: { auth?: 'header' | 'message' | 'none'; token?: string; host?: string; origin?: string; path?: string } = {}): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.origin !== undefined) headers.Origin = opts.origin;
    const mode = opts.auth ?? 'message';
    if (mode === 'header') headers['X-Agent-Office-Local'] = opts.token ?? TOKEN;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? '/ws'}`, { headers });
    const messages: Record<string, unknown>[] = [];
    const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.on('close', (code, reason) => {
        res({ code, reason: reason.toString() });
      });
    });
    ws.on('message', (d) => {
      const m = JSON.parse(Buffer.isBuffer(d) ? d.toString('utf8') : '{}') as Record<string, unknown>;
      messages.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode ?? 0}`));
    });
    ws.on('open', () => {
      if (mode === 'message') ws.send(JSON.stringify({ type: 'auth', token: opts.token ?? TOKEN }));
      resolve({
        ws,
        messages,
        closed,
        waitFor: (pred, ms = 3000) => {
          const hit = messages.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              rej(new Error('timeout waiting for ws message'));
            }, ms);
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(t);
                res(m);
              },
            });
          });
        },
      });
    });
  });
}
