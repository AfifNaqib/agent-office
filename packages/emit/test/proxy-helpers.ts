// Test helpers for plan A3.1 (re-exec through the proxy): a process probe loaded
// with NODE_OPTIONS=--import, a mock CONNECT proxy (optionally terminating TLS
// for a fake relay host), and a relay mock that answers a scripted status list.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { tempDir } from './helpers.js';

export const RELAY_HOST = 'relay.test';

/**
 * Loaded into EVERY node process of a run (the parent, and the child through the
 * inherited NODE_OPTIONS). Logs pid, ppid, flag and marker as one JSON line.
 * AO_PROBE_CHILD = crash | hang | slow changes only the re-exec child.
 */
const PROBE = `import { appendFileSync } from 'node:fs';
const e = process.env;
appendFileSync(e.AO_PROBE_LOG, JSON.stringify({ pid: process.pid, ppid: process.ppid, flag: e.NODE_USE_ENV_PROXY ?? null, marker: e.AGENT_OFFICE_EMIT_REEXEC ?? null }) + '\\n');
const mode = e.AO_PROBE_CHILD;
if (e.AGENT_OFFICE_EMIT_REEXEC !== undefined && mode) {
  if (mode === 'crash') { process.stdout.write('child noise\\n'); process.stderr.write('child err\\n'); process.exit(3); }
  if (mode === 'hang') { process.stdout.write('child noise\\n'); setInterval(() => undefined, 1000); await new Promise(() => undefined); }
  if (mode === 'slow') { await new Promise((r) => setTimeout(r, 4000)); }
}
`;

export interface ProbeLine {
  readonly pid: number;
  readonly ppid: number;
  readonly flag: string | null;
  readonly marker: string | null;
}

export interface Probe {
  /** Add to the emit environment. */
  readonly env: Record<string, string>;
  lines(): ProbeLine[];
}

export function probe(): Probe {
  const dir = tempDir('ao-probe-');
  const file = join(dir, 'probe.mjs');
  const log = join(dir, 'probe.log');
  writeFileSync(file, PROBE);
  writeFileSync(log, '');
  return {
    env: { NODE_OPTIONS: `--import=${pathToFileURL(file).href}`, AO_PROBE_LOG: log },
    lines: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as ProbeLine),
  };
}

/** True while the process runs. A zombie (killed, not yet reaped by a container init) counts as gone. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true;
  }
}

export interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function listen(server: Server, sockets: Set<Socket>): Promise<number> {
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      r((server.address() as AddressInfo).port);
    }),
  );
}

function closer(server: Server, sockets: Set<Socket>): () => Promise<void> {
  return () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => {
        r();
      });
    });
}

/** HTTP handler that records each request and answers statuses[i] (the last one repeats). */
function scripted(statuses: readonly number[], seen: Seen[]): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void {
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = statuses[Math.min(seen.length - 1, statuses.length - 1)] ?? 204;
      res.end();
    });
  };
}

export interface Relay {
  readonly port: number;
  readonly requests: Seen[];
  /** Arrival times (ms), same order as requests. */
  readonly times: number[];
  close(): Promise<void>;
}

/** A plain-HTTP relay on loopback that answers the scripted statuses. */
export async function scriptedRelay(statuses: readonly number[]): Promise<Relay> {
  const requests: Seen[] = [];
  const times: number[] = [];
  const handler = scripted(statuses, requests);
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    times.push(Date.now());
    handler(req, res);
  });
  const port = await listen(server, sockets);
  return { port, requests, times, close: closer(server, sockets) };
}

export interface TlsMaterial {
  readonly key: string;
  readonly cert: string;
  readonly certFile: string;
}

/** A throwaway self-signed cert for relay.test (made at test time; nothing is committed). Null without openssl. */
export function makeCert(): TlsMaterial | null {
  const dir = tempDir('ao-cert-');
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', `/CN=${RELAY_HOST}`, '-addext', `subjectAltName=DNS:${RELAY_HOST}`, '-days', '2'],
      { stdio: 'ignore' },
    );
  } catch {
    return null;
  }
  if (!existsSync(certFile)) return null;
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8'), certFile };
}

export interface Proxy {
  readonly url: string;
  /** CONNECT requests: target (host:port) and the proxy request headers. */
  readonly connects: { readonly target: string | undefined; readonly headers: IncomingHttpHeaders }[];
  /** Plain (non-CONNECT) proxy requests. Expected to stay empty. */
  readonly forwards: Seen[];
  /** Requests seen INSIDE the TLS tunnel (only with `tls`). */
  readonly inner: Seen[];
  close(): Promise<void>;
}

/**
 * Mock egress proxy. Without `tls` it records each CONNECT and refuses it (502).
 * With `tls` it accepts CONNECT to relay.test:443, ends TLS with the test cert and
 * answers the inner requests with `statuses` (a stand-in for the real relay).
 */
export async function mockProxy(opts: { tls?: TlsMaterial; statuses?: readonly number[] } = {}): Promise<Proxy> {
  const connects: Proxy['connects'] = [];
  const forwards: Seen[] = [];
  const inner: Seen[] = [];
  const sockets = new Set<Socket>();
  const innerServer = createServer(scripted(opts.statuses ?? [204], inner));
  const server = createServer(scripted([502], forwards));
  server.on('connect', (req, socket: Socket) => {
    connects.push({ target: req.url, headers: req.headers });
    sockets.add(socket);
    if (!opts.tls || req.url !== `${RELAY_HOST}:443`) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const tlsSocket = new TLSSocket(socket, { isServer: true, key: opts.tls.key, cert: opts.tls.cert });
    tlsSocket.on('error', () => undefined);
    innerServer.emit('connection', tlsSocket);
  });
  const port = await listen(server, sockets);
  return { url: `http://127.0.0.1:${port}`, connects, forwards, inner, close: closer(server, sockets) };
}
