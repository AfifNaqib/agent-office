// V1-05: the relay Worker under `wrangler dev` (local workerd, no Cloudflare
// account), serving the BUILT web app (packages/web/dist) as its static assets.
// Uses the TEST ONLY relay entry (packages/relay/test/workerd/), which checks
// Access JWTs against a key set passed in a var; the test signs real RS256 JWTs.
//
// The browser talks to a small local "Access stand-in" proxy in front of wrangler
// dev that adds `Cf-Access-Jwt-Assertion` to every request, WebSocket upgrades
// included, as Cloudflare Access does in production after login (Playwright's
// extraHTTPHeaders do not reach WebSocket upgrades). Events go straight to
// wrangler dev over POST /ingest with the Bearer, like a cloud hook.
import { request as httpRequest, createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { test as base, expect } from '@playwright/test';
import type { OfficeEvent } from '@agent-office/core';
import { AUD, KID, TEAM, TEAM_KEY, TOKEN, accessJwt, publicJwk, sha } from '../../relay/test/helpers.js';
import { startWrangler, type Wrangler } from '../../relay/test/workerdRig.js';
import { readTeamRun } from '../test/helpers/team-run.js';

const JWT_HEADER = 'cf-access-jwt-assertion';

/** Request headers with the stand-in JWT set (any client-sent one dropped). */
function withJwt(headers: IncomingHttpHeaders, jwt: string | null): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers };
  delete out['cf-access-jwt-assertion'];
  if (jwt) out[JWT_HEADER] = jwt;
  return out;
}

/** Forwards HTTP and WebSocket upgrades to `targetPort`, adding the current JWT. Host is kept, so Origin checks see the proxy's origin. */
function accessStandIn(targetPort: number, jwt: () => string | null): Promise<Server> {
  const server = createServer((req, res) => {
    const up = httpRequest({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: withJwt(req.headers, jwt()) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = connect(targetPort, '127.0.0.1', () => {
      const headers = withJwt(req.headers, jwt());
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v ?? '']) lines.push(`${k}: ${one}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = (): void => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', end);
    socket.on('error', end);
    up.on('close', end);
    socket.on('close', end);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

export class RelayRig {
  private n = 0;
  private constructor(
    private readonly w: Wrangler,
    private readonly proxy: Server,
    /** The JWT the stand-in adds (shared with the proxy); null = logged out. */
    private readonly session: { jwt: string | null },
  ) {}

  static async start(): Promise<RelayRig> {
    const jwks = JSON.stringify({ keys: [publicJwk(TEAM_KEY.publicKey, KID)] });
    const w = await startWrangler(['--config', 'test/workerd/wrangler.jsonc'], {
      INGEST_TOKEN: TOKEN,
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      TEST_ACCESS_JWKS: jwks,
    });
    const session: { jwt: string | null } = { jwt: null };
    const proxy = await accessStandIn(Number(new URL(w.base).port), () => session.jwt);
    return new RelayRig(w, proxy, session);
  }

  /** What the browser opens: the Access stand-in in front of the relay. */
  get url(): string {
    return `http://127.0.0.1:${(this.proxy.address() as AddressInfo).port}`;
  }

  /** wrangler dev itself (no JWT added). */
  get direct(): string {
    return this.w.base;
  }

  output(): string {
    return this.w.output();
  }

  async dispose(): Promise<void> {
    this.proxy.closeAllConnections();
    await new Promise((r) => this.proxy.close(r));
    await this.w.dispose();
  }

  /** "Logs in": every request through `url` now carries a fresh Access JWT (exp `expSec` from now). null = logged out. */
  async login(expSec: number | null = 3600): Promise<void> {
    this.session.jwt = expSec === null ? null : await accessJwt({ now: Date.now(), expOffset: expSec });
  }

  /** POST /ingest like a cloud hook; the relay answers 204 when stored. */
  async ingest(e: OfficeEvent): Promise<void> {
    const res = await fetch(`${this.direct}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(e),
    });
    expect(res.status, `POST /ingest -> ${res.status}`).toBe(204);
  }

  event(over: Partial<OfficeEvent> & Pick<OfficeEvent, 'kind' | 'sessionId'>): OfficeEvent {
    this.n += 1;
    return { v: 1, id: sha(`relay-rig-${this.direct}-${this.n}-${Math.random()}`), emittedAt: Date.now(), source: 'cloud', repo: 'portfolio', actor: { kind: 'main', agentType: null, agentId: null }, ...over };
  }

  /** The observed team run, moved to "now", cut after the first `until` match, as a cloud session. */
  async playTeamRun(sessionId: string, repo: string, until: (e: OfficeEvent) => boolean, endAgoMs = 1_000): Promise<void> {
    const all = readTeamRun();
    const events = all.slice(0, all.findIndex(until) + 1);
    const shift = Date.now() - endAgoMs - (events.at(-1)?.emittedAt ?? 0);
    for (const e of events) {
      await this.ingest({ ...e, id: sha(`${sessionId}:${e.id}`), sessionId, repo, source: 'cloud', emittedAt: e.emittedAt + shift });
    }
  }
}

// One wrangler dev per Playwright worker (it takes ~10 s to start); tests use their own session ids
// and start logged out.
export const test = base.extend<{ relay: RelayRig }, { relayWorker: RelayRig }>({
  relayWorker: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const rig = await RelayRig.start();
      await use(rig);
      await rig.dispose();
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  relay: async ({ relayWorker }, use) => {
    await relayWorker.login(null);
    await use(relayWorker);
  },
});
export { expect };
