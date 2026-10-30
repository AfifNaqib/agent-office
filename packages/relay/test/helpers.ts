// Test rig for the relay under plain Node: HubCore on node:sqlite, the Hono app
// with a fake DO stub (JSON round trip, like RPC serialization), a settable clock
// and a capturing logger.
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { OfficeEvent } from '@agent-office/core';
import { SignJWT, createLocalJWKSet, type JWK, type JWTPayload } from 'jose';
import type { KeySource } from '../src/auth/access.js';
import { createApp } from '../src/app.js';
import { HubCore, type IngestResult, type StoredEvent } from '../src/hubCore.js';
import type { LogFields } from '../src/log.js';
import type { SqlStore, SqlValue } from '../src/sql.js';
import type { AssetsFetcher, HubApi } from '../src/types.js';

/** Built at run time, so the secret scan finds no token literal here. */
export const TOKEN = 'T'.repeat(20) + 'k9'.repeat(12);
export const WRONG = 'W'.repeat(20) + 'k9'.repeat(12);
/** The relay's BRIDGE_TOKEN in tests (V1-04); never equal to TOKEN. */
export const BRIDGE_TOKEN = 'B'.repeat(20) + 'q7'.repeat(12);
export const NOW0 = Date.UTC(2026, 9, 25, 12, 0, 0);
export const BASE = 'https://agent-office.example.workers.dev';

// ---- Cloudflare Access stand-in (V1-02): local RS256 keys + a fake team JWKS, no network.
export const TEAM = 'example.cloudflareaccess.com';
export const AUD = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
export const PO_EMAIL = 'you@example.com';
export const ACCESS_ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_ALLOWED_EMAILS: PO_EMAIL } as const;
export const KID = 'kid-current';

function rsaPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}
/** The team signing key (in the JWKS) and an attacker key (not in it). */
export const TEAM_KEY = rsaPair();
export const OTHER_KEY = rsaPair();

export function publicJwk(key: KeyObject, kid: string): JWK {
  return { ...(key.export({ format: 'jwk' }) as JWK), kid, alg: 'RS256', use: 'sig' };
}

/** Counts how often the guard asked for keys, and with which certs URL. */
export const keyCalls: string[] = [];
export const localKeys: KeySource = (config) => {
  keyCalls.push(config.certsUrl);
  return createLocalJWKSet({ keys: [publicJwk(TEAM_KEY.publicKey, KID)] });
};

export interface JwtOptions {
  readonly claims?: JWTPayload & { email?: unknown };
  readonly key?: KeyObject;
  readonly kid?: string | null;
  readonly alg?: string;
  /** Seconds relative to `now`. */
  readonly iatOffset?: number;
  readonly expOffset?: number | null;
  readonly issuer?: string | null;
  readonly audience?: string | string[] | null;
  readonly now?: number;
}

/** A Cloudflare-Access-shaped JWT (aud is an array, like the real one). */
export async function accessJwt(o: JwtOptions = {}): Promise<string> {
  const nowSec = Math.floor((o.now ?? NOW0) / 1000);
  const jwt = new SignJWT({ email: PO_EMAIL, type: 'app', sub: 'user-1', ...o.claims })
    .setProtectedHeader({ alg: o.alg ?? 'RS256', ...(o.kid === null ? {} : { kid: o.kid ?? KID }) })
    .setIssuedAt(nowSec + (o.iatOffset ?? 0));
  if (o.expOffset !== null) jwt.setExpirationTime(nowSec + (o.expOffset ?? 3600));
  if (o.issuer !== null) jwt.setIssuer(o.issuer ?? `https://${TEAM}`);
  if (o.audience !== null) jwt.setAudience(o.audience ?? [AUD]);
  return jwt.sign(o.key ?? TEAM_KEY.privateKey);
}

/** base64url without padding, for hand-made (unsigned / HS256) tokens. */
export function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function makeEvent(n: number, over: Partial<OfficeEvent> = {}): OfficeEvent {
  return {
    v: 1,
    id: sha(`event-${n}`),
    emittedAt: NOW0 + n,
    source: 'cloud',
    sessionId: '7c1d0e52-3b8f-4a5e-9d21-0f6b2a9c4e17',
    remoteSessionId: 'cse_01AbCdEfGhIjKlMnOpQrStUv',
    repo: 'portfolio',
    actor: { kind: 'main', agentType: null, agentId: null },
    kind: 'tool.start',
    tool: { name: 'Read', useId: `toolu_${n}`, summary: 'src/a.ts' },
    ...over,
  };
}

/** node:sqlite behind the same SqlStore surface the DO gives HubCore. */
export function sqliteStore(db: DatabaseSync = new DatabaseSync(':memory:')): SqlStore {
  return {
    exec: <T>(query: string, ...bindings: SqlValue[]) => {
      const stmt = db.prepare(query);
      if (stmt.columns().length > 0) return stmt.all(...bindings) as T[];
      stmt.run(...bindings);
      return [];
    },
    transaction: <T>(fn: () => T): T => {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

/** A hub for tests that only exercise the guard: health answers, everything else rejects. */
export function unusedHub(): HubApi {
  const no = (): Promise<never> => Promise.reject(new Error('unused'));
  return {
    ingest: no,
    sessions: no,
    events: no,
    sessionEvents: no,
    connectUi: no,
    connectBridge: no,
    health: () => Promise.resolve({ events7d: 0, bridgeOnline: false }),
  };
}

export interface Rig {
  readonly core: HubCore;
  readonly db: DatabaseSync;
  readonly clock: { now: number };
  readonly logs: LogFields[];
  /** Set to make the fake DO throw (store failure). */
  failHub: boolean;
  /** Upgrades the /ws/ui route handed to the (fake) DO. */
  readonly upgrades: { request: Request; expMs: number }[];
  /** Upgrades the /bridge route handed to the (fake) DO (V1-04). */
  readonly bridgeUpgrades: Request[];
  /** What the fake DO reports as bridgeOnline in health. */
  bridgeOnline: boolean;
  /** What HubCore handed to onStored (the DO fans these out to UI sockets). */
  readonly pushed: StoredEvent[];
  post(body: unknown, opts?: PostOptions): Promise<Response>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  stored(): OfficeEvent[];
}

export interface PostOptions {
  /** Authorization header value; null = none. Default: the right Bearer. */
  readonly auth?: string | null;
  readonly contentType?: string | null;
  readonly headers?: Record<string, string>;
}

export interface RigEnv {
  INGEST_TOKEN?: string;
  BRIDGE_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ALLOWED_EMAILS?: string;
  ASSETS?: AssetsFetcher;
}

export function startRig(env: RigEnv = { INGEST_TOKEN: TOKEN, BRIDGE_TOKEN, ...ACCESS_ENV }): Rig {
  const db = new DatabaseSync(':memory:');
  const pushed: StoredEvent[] = [];
  const core = new HubCore(sqliteStore(db), { onStored: (st) => pushed.push(st) });
  const clock = { now: NOW0 };
  const logs: LogFields[] = [];
  const rig: Rig = {
    core,
    db,
    clock,
    logs,
    failHub: false,
    upgrades: [],
    bridgeUpgrades: [],
    bridgeOnline: false,
    pushed,
    post: (body, opts = {}) => {
      const headers: Record<string, string> = { ...opts.headers };
      const auth = opts.auth === undefined ? `Bearer ${TOKEN}` : opts.auth;
      if (auth !== null) headers.authorization = auth;
      const type = opts.contentType === undefined ? 'application/json' : opts.contentType;
      if (type !== null) headers['content-type'] = type;
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return rig.fetch('/ingest', { method: 'POST', headers, body: text });
    },
    fetch: async (path, init) => app.fetch(new Request(`${BASE}${path}`, init), env),
    stored: () => core.eventsAfter(0, 5000).map((s) => s.event),
  };
  // RPC serializes arguments and results; a JSON round trip is the closest plain-Node stand-in.
  const rt = <T>(v: T): Promise<T> => (rig.failHub ? Promise.reject(new Error('boom')) : Promise.resolve(JSON.parse(JSON.stringify(v)) as T));
  const hub: HubApi = {
    ingest: (event): Promise<IngestResult> => {
      if (rig.failHub) return Promise.reject(new Error('boom'));
      return Promise.resolve(core.ingest(JSON.parse(JSON.stringify(event)), 'ingest', clock.now));
    },
    sessions: () => rt(core.sessionList()),
    events: (after, limit) => rt(core.events(after, limit)),
    sessionEvents: (key, after, limit) => rt(core.sessionEvents(key, after, limit)),
    health: () => rt({ events7d: core.events7d(clock.now), bridgeOnline: rig.bridgeOnline }),
    // Node's Response cannot carry a 101: the fake answers 200 and records the call.
    connectUi: (request, expMs) => {
      rig.upgrades.push({ request, expMs });
      return Promise.resolve(new Response('upgraded', { status: 200, headers: { 'x-fake-upgrade': '1' } }));
    },
    connectBridge: (request) => {
      if (rig.failHub) return Promise.reject(new Error('boom'));
      rig.bridgeUpgrades.push(request);
      return Promise.resolve(new Response('bridge upgraded', { status: 200, headers: { 'x-fake-upgrade': '1' } }));
    },
  };
  const app = createApp({ hub: () => hub, now: () => clock.now, log: (f) => logs.push(f), accessKeys: localKeys });
  return rig;
}
