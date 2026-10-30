// A stand-in for the relay's /bridge socket (V1-04 protocol, packages/relay/src/bridgeSockets.ts)
// on 127.0.0.1, so the bridge's relay client is tested without workerd. It can be
// stopped and started again on the same port, and records everything it receives.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

export type AnswerMode = 'ack' | 'silent' | 'reject' | 'retry';

export interface FakeRelay {
  readonly port: number;
  readonly url: string;
  /** Upgrade request headers, one entry per attempt (accepted or not). */
  readonly upgrades: IncomingHttpHeaders[];
  /** Every text message received, raw. */
  readonly raw: string[];
  /** Times each event id arrived. */
  readonly received: Map<string, number>;
  /** Ids stored (first arrival while answering 'ack'). */
  readonly stored: string[];
  /** How the relay answers events. */
  mode: AnswerMode;
  /** Answer "ping" with "pong" (default true). */
  pong: boolean;
  /** Status to refuse upgrades with (e.g. 401); undefined = accept a right token. */
  refuse: number | undefined;
  readonly sockets: Set<WebSocket>;
  start(): Promise<void>;
  /** Stops listening and drops every socket (like a relay going away). */
  stop(): Promise<void>;
}

export async function startFakeRelay(token: string, port = 0): Promise<FakeRelay> {
  let server: Server | undefined;
  const wss = new WebSocketServer({ noServer: true });
  const relay: FakeRelay = {
    port,
    url: '',
    upgrades: [],
    raw: [],
    received: new Map(),
    stored: [],
    mode: 'ack',
    pong: true,
    refuse: undefined,
    sockets: new Set(),
    start: async () => {
      server = createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
      });
      server.on('upgrade', (req, socket: Duplex, head) => {
        relay.upgrades.push(req.headers);
        const status = relay.refuse ?? (req.url === '/bridge' && req.headers.authorization === `Bearer ${token}` ? undefined : 401);
        if (status !== undefined) {
          socket.write(`HTTP/1.1 ${status} No\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          relay.sockets.add(ws);
          ws.on('close', () => relay.sockets.delete(ws));
          ws.on('message', (data: Buffer) => {
            const text = data.toString('utf8');
            relay.raw.push(text);
            if (text === 'ping') {
              if (relay.pong) ws.send('pong');
              return;
            }
            const msg = JSON.parse(text) as { type: string; event: { id: string } };
            const id = msg.event.id;
            relay.received.set(id, (relay.received.get(id) ?? 0) + 1);
            if (relay.mode === 'silent') return;
            if (relay.mode === 'reject') ws.send(JSON.stringify({ type: 'reject', id, code: 'invalid_event' }));
            else if (relay.mode === 'retry') ws.send(JSON.stringify({ type: 'retry', id, retryAfterSec: 1 }));
            else {
              if (!relay.stored.includes(id)) relay.stored.push(id);
              ws.send(JSON.stringify({ type: 'ack', id }));
            }
          });
        });
      });
      const srv = server;
      await new Promise<void>((resolve) => {
        srv.listen(relay.port, '127.0.0.1', () => {
          resolve();
        });
      });
      const p = (srv.address() as AddressInfo).port;
      (relay as { port: number }).port = p;
      (relay as { url: string }).url = `ws://127.0.0.1:${p}/bridge`;
    },
    stop: async () => {
      for (const ws of relay.sockets) ws.terminate();
      relay.sockets.clear();
      const srv = server;
      server = undefined;
      if (!srv) return;
      await new Promise<void>((resolve) => {
        srv.close(() => {
          resolve();
        });
        srv.closeAllConnections();
      });
    },
  };
  await relay.start();
  return relay;
}
