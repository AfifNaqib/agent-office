// V1-02: Cloudflare Access JWT verification, bypass/protected path matrix, Origin
// checks and security headers. Local RS256 keys and a fake JWKS: no network.
import { errors } from 'jose';
import { describe, expect, it } from 'vitest';
import { accessConfig, type KeySource } from '../src/auth/access.js';
import { contentSecurityPolicy } from '../src/auth/guard.js';
import {
  ACCESS_ENV,
  AUD,
  BASE,
  KID,
  NOW0,
  OTHER_KEY,
  PO_EMAIL,
  TEAM,
  TEAM_KEY,
  TOKEN,
  accessJwt,
  b64url,
  keyCalls,
  makeEvent,
  publicJwk,
  startRig,
  unusedHub,
  type Rig,
} from './helpers.js';

const HOST = new URL(BASE).host;
const H = 'cf-access-jwt-assertion';

function get(r: Rig, path: string, jwt?: string, headers: Record<string, string> = {}): Promise<Response> {
  return r.fetch(path, { headers: { ...(jwt === undefined ? {} : { [H]: jwt }), ...headers } });
}

async function statusWith(jwt: string | undefined, path = '/api/health'): Promise<number> {
  return (await get(startRig(), path, jwt)).status;
}

describe('AC: Access JWT (plan §11 layer 1)', () => {
  it('valid JWT -> 200; the certs URL is the team one', async () => {
    keyCalls.length = 0;
    const r = startRig();
    const res = await get(r, '/api/health', await accessJwt());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bridgeOnline: false, events7d: 0 });
    expect(keyCalls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it.each([
    ['no header', undefined],
    ['empty header', ''],
    ['spaces only', '   '],
    ['garbage', 'not-a-jwt'],
    ['two parts', 'a.b'],
  ])('missing or malformed (%s) -> 401', async (_n, jwt) => {
    const r = startRig();
    const res = await get(r, '/api/health', jwt);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'Missing or invalid Access login' } });
  });

  it('expired -> 401 (log kind "expired"); within the 30 s clock tolerance -> 200', async () => {
    const r = startRig();
    expect((await get(r, '/api/health', await accessJwt({ iatOffset: -7200, expOffset: -3600 }))).status).toBe(401);
    expect(r.logs.at(-1)).toEqual({ route: 'access', status: 401, kind: 'expired' });
    expect(await statusWith(await accessJwt({ iatOffset: -100, expOffset: -31 }))).toBe(401);
    expect(await statusWith(await accessJwt({ iatOffset: -100, expOffset: -10 }))).toBe(200);
  });

  it('no exp or no iat -> 401; nbf in the future -> 401', async () => {
    expect(await statusWith(await accessJwt({ expOffset: null }))).toBe(401);
    expect(await statusWith(await accessJwt({ claims: { nbf: Math.floor(NOW0 / 1000) + 600 } }))).toBe(401);
    // iat removed by hand: re-sign without it.
    const { SignJWT } = await import('jose');
    const noIat = await new SignJWT({ email: PO_EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM}`)
      .setAudience([AUD])
      .setExpirationTime(Math.floor(NOW0 / 1000) + 600)
      .sign(TEAM_KEY.privateKey);
    expect(await statusWith(noIat)).toBe(401);
  });

  it.each([
    ['other audience', ['b'.repeat(64)]],
    ['empty audience list', []],
    ['audience as a prefix', [AUD.slice(0, -1)]],
  ])('wrong aud (%s) -> 401', async (_n, audience) => {
    expect(await statusWith(await accessJwt({ audience }))).toBe(401);
  });

  it('missing aud -> 401; aud list holding ours among others -> 200', async () => {
    expect(await statusWith(await accessJwt({ audience: null }))).toBe(401);
    expect(await statusWith(await accessJwt({ audience: ['x'.repeat(64), AUD] }))).toBe(200);
  });

  it.each([
    ['other team', 'https://evil.cloudflareaccess.com'],
    ['http scheme', `http://${TEAM}`],
    ['trailing slash', `https://${TEAM}/`],
    ['look-alike host', `https://${TEAM}.evil.example`],
  ])('wrong iss (%s) -> 401', async (_n, issuer) => {
    expect(await statusWith(await accessJwt({ issuer }))).toBe(401);
  });

  it('missing iss -> 401', async () => {
    expect(await statusWith(await accessJwt({ issuer: null }))).toBe(401);
  });

  it('forged: signed by a key not in the JWKS (with the real kid, another kid, or no kid) -> 401', async () => {
    expect(await statusWith(await accessJwt({ key: OTHER_KEY.privateKey }))).toBe(401);
    expect(await statusWith(await accessJwt({ key: OTHER_KEY.privateKey, kid: 'kid-attacker' }))).toBe(401);
    expect(await statusWith(await accessJwt({ key: OTHER_KEY.privateKey, kid: null }))).toBe(401);
  });

  it('unknown kid -> 401 even when signed with the team key', async () => {
    expect(await statusWith(await accessJwt({ kid: 'kid-rotated-away' }))).toBe(401);
  });

  it('tampered payload (email swapped after signing) -> 401', async () => {
    const good = await accessJwt({ claims: { email: 'someone@else.example' } });
    const [h, , s] = good.split('.');
    const forged = `${h}.${b64url(JSON.stringify({ email: PO_EMAIL, iss: `https://${TEAM}`, aud: [AUD], iat: NOW0 / 1000, exp: NOW0 / 1000 + 600 }))}.${s}`;
    expect(await statusWith(forged)).toBe(401);
  });

  it('alg "none" (unsigned) -> 401', async () => {
    const header = b64url(JSON.stringify({ alg: 'none', kid: KID }));
    const now = Math.floor(NOW0 / 1000);
    const payload = b64url(JSON.stringify({ email: PO_EMAIL, iss: `https://${TEAM}`, aud: [AUD], iat: now, exp: now + 600 }));
    expect(await statusWith(`${header}.${payload}.`)).toBe(401);
    expect(await statusWith(`${header}.${payload}`)).toBe(401);
  });

  it('HS256 key confusion (public key bytes used as the HMAC secret) -> 401', async () => {
    const { createHmac } = await import('node:crypto');
    const now = Math.floor(NOW0 / 1000);
    const header = b64url(JSON.stringify({ alg: 'HS256', kid: KID, typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ email: PO_EMAIL, iss: `https://${TEAM}`, aud: [AUD], iat: now, exp: now + 600 }));
    for (const secret of [
      TEAM_KEY.publicKey.export({ format: 'pem', type: 'spki' }),
      JSON.stringify(publicJwk(TEAM_KEY.publicKey, KID)),
    ]) {
      const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
      expect(await statusWith(`${header}.${payload}.${sig}`)).toBe(401);
    }
  });

  it('a stronger RSA alg than RS256 (RS512, PS256) with the team key is still refused', async () => {
    expect(await statusWith(await accessJwt({ alg: 'RS512' }))).toBe(401);
    expect(await statusWith(await accessJwt({ alg: 'PS256' }))).toBe(401);
  });

  it('the RS256-only rule holds even when the JWKS key has no "alg" field', async () => {
    const { createApp } = await import('../src/app.js');
    const { createLocalJWKSet } = await import('jose');
    const noAlg = { ...publicJwk(TEAM_KEY.publicKey, KID) };
    delete noAlg.alg;
    const keys: KeySource = () => createLocalJWKSet({ keys: [noAlg] });
    const app = createApp({ hub: () => unusedHub(), now: () => NOW0, log: () => undefined, accessKeys: keys });
    const status = async (jwt: string): Promise<number> =>
      (await app.fetch(new Request(`${BASE}/api/health`, { headers: { [H]: jwt } }), { ...ACCESS_ENV })).status;
    expect(await status(await accessJwt())).toBe(200);
    expect(await status(await accessJwt({ alg: 'RS512' }))).toBe(401);
    expect(await status(await accessJwt({ alg: 'PS256' }))).toBe(401);
  });

  it('an oversized header (> 8 KB) -> 401 without parsing', async () => {
    expect(await statusWith(`${await accessJwt()}${'A'.repeat(9000)}`)).toBe(401);
  });

  it('the JWT is read only from Cf-Access-Jwt-Assertion (not the CF_Authorization cookie or Authorization)', async () => {
    const jwt = await accessJwt();
    const r = startRig();
    expect((await r.fetch('/api/health', { headers: { cookie: `CF_Authorization=${jwt}` } })).status).toBe(401);
    expect((await r.fetch('/api/health', { headers: { authorization: `Bearer ${jwt}` } })).status).toBe(401);
  });
});

describe('AC: email allowlist (FR-019, plan D1)', () => {
  it.each([
    ['another email', { email: 'intruder@example.com' }],
    ['look-alike email', { email: `${PO_EMAIL}.evil.example` }],
    ['no email (service token)', { email: undefined, common_name: 'svc.access' }],
    ['email as a list', { email: [PO_EMAIL] }],
    ['empty email', { email: '' }],
  ])('%s -> 403', async (_n, claims) => {
    const r = startRig();
    const res = await get(r, '/api/health', await accessJwt({ claims }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'forbidden', message: 'Not allowed' } });
    expect(r.logs.at(-1)).toEqual({ route: 'access', status: 403, kind: 'email' });
  });

  it('email compare ignores case', async () => {
    expect(await statusWith(await accessJwt({ claims: { email: PO_EMAIL.toUpperCase() } }))).toBe(200);
  });

  it('logs never hold the JWT or the email', async () => {
    const r = startRig();
    const jwt = await accessJwt();
    await get(r, '/api/health', jwt);
    await get(r, '/api/health', await accessJwt({ claims: { email: 'intruder@example.com' } }));
    await get(r, '/api/health', `${jwt}x`);
    const all = JSON.stringify(r.logs);
    for (const bad of [jwt.slice(0, 40), jwt.split('.')[2] ?? '', PO_EMAIL, 'intruder']) expect(all).not.toContain(bad);
  });
});

describe('fails closed on Access settings', () => {
  const base = { INGEST_TOKEN: TOKEN, ...ACCESS_ENV };
  it.each([
    ['no team domain', { ...base, ACCESS_TEAM_DOMAIN: undefined }],
    ['no AUD', { ...base, ACCESS_AUD: undefined }],
    ['empty AUD', { ...base, ACCESS_AUD: '  ' }],
    ['short AUD', { ...base, ACCESS_AUD: 'abc' }],
    ['team domain not on cloudflareaccess.com', { ...base, ACCESS_TEAM_DOMAIN: 'evil.example' }],
    ['look-alike team domain', { ...base, ACCESS_TEAM_DOMAIN: `${TEAM}.evil.example` }],
    ['team domain with a path', { ...base, ACCESS_TEAM_DOMAIN: `${TEAM}/x` }],
    ['team domain with a port', { ...base, ACCESS_TEAM_DOMAIN: `${TEAM}:8443` }],
    ['no allowed emails', { ...base, ACCESS_ALLOWED_EMAILS: undefined }],
    ['blank allowed emails', { ...base, ACCESS_ALLOWED_EMAILS: ' , ' }],
    ['malformed allowed email', { ...base, ACCESS_ALLOWED_EMAILS: 'not-an-email' }],
  ])('%s -> 503 on protected paths, even with a valid JWT; /ingest unaffected', async (_n, env) => {
    const r = startRig(env);
    const res = await get(r, '/api/health', await accessJwt());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'not_configured', message: 'Relay is not configured' } });
    expect((await get(r, '/api/health')).status).toBe(503);
    expect((await r.post(makeEvent(1))).status).toBe(204);
  });

  it('team domain with an https:// prefix, trailing slash or capitals is accepted', () => {
    for (const d of [`https://${TEAM}`, `https://${TEAM}/`, TEAM.toUpperCase(), ` ${TEAM} `]) {
      expect(accessConfig({ ...ACCESS_ENV, ACCESS_TEAM_DOMAIN: d })?.issuer).toBe(`https://${TEAM}`);
    }
  });

  it('several allowed emails (comma list) parse; any malformed one fails the whole config', () => {
    expect(accessConfig({ ...ACCESS_ENV, ACCESS_ALLOWED_EMAILS: `${PO_EMAIL}, Other@Example.com` })?.emails).toEqual(
      new Set([PO_EMAIL, 'other@example.com']),
    );
    expect(accessConfig({ ...ACCESS_ENV, ACCESS_ALLOWED_EMAILS: `${PO_EMAIL}, bad email@x` })).toBeNull();
  });

  it('certs cannot be fetched (timeout / invalid JWKS) -> 503, never open', async () => {
    const { createApp } = await import('../src/app.js');
    for (const err of [new errors.JWKSTimeout(), new errors.JWKSInvalid('bad')]) {
      const failing: KeySource = () => () => Promise.reject(err);
      const logs: unknown[] = [];
      const app = createApp({ hub: () => unusedHub(), now: () => NOW0, log: (f) => logs.push(f), accessKeys: failing });
      const res = await app.fetch(new Request(`${BASE}/api/health`, { headers: { [H]: await accessJwt() } }), { ...ACCESS_ENV });
      expect(res.status).toBe(503);
      expect(logs).toEqual([{ route: 'access', status: 503, kind: 'certs' }]);
    }
  });

  it('any other key-source error (network, DNS, generic) -> 503 certs (L-1), never open', async () => {
    const { createApp } = await import('../src/app.js');
    for (const err of [new TypeError('fetch failed'), new Error('getaddrinfo ENOTFOUND'), new errors.JOSEError('Expected 200 OK')]) {
      const failing: KeySource = () => () => Promise.reject(err);
      const logs: unknown[] = [];
      const app = createApp({ hub: () => unusedHub(), now: () => NOW0, log: (f) => logs.push(f), accessKeys: failing });
      const res = await app.fetch(new Request(`${BASE}/api/health`, { headers: { [H]: await accessJwt() } }), { ...ACCESS_ENV });
      expect(res.status).toBe(503);
      expect(logs).toEqual([{ route: 'access', status: 503, kind: 'certs' }]);
    }
  });
});

describe('L-1: remote certs source (makeRemoteKeys, fake fetch)', () => {
  const jwks = (): Response => Response.json({ keys: [publicJwk(TEAM_KEY.publicKey, KID)] });

  /** `fetchImpl` answers synchronously; a throw becomes a rejected fetch. */
  async function rig(fetchImpl: (url: string) => Response) {
    const { createApp } = await import('../src/app.js');
    const { makeRemoteKeys } = await import('../src/auth/access.js');
    const clock = { t: NOW0 };
    const calls: string[] = [];
    const keys = makeRemoteKeys({
      now: () => clock.t,
      fetch: (url) => {
        calls.push(url);
        try {
          return Promise.resolve(fetchImpl(url));
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
    const logs: { kind?: string }[] = [];
    const app = createApp({ hub: () => unusedHub(), now: () => clock.t, log: (f) => logs.push(f as { kind?: string }), accessKeys: keys });
    const status = async (jwt: string): Promise<number> =>
      (await app.fetch(new Request(`${BASE}/api/health`, { headers: { [H]: jwt } }), { ...ACCESS_ENV })).status;
    return { clock, calls, logs, status };
  }

  it('network error -> 503 certs; repeated requests within 30 s -> one fetch only; recovery after the window', async () => {
    let down = true;
    const r = await rig(() => {
      if (down) throw new TypeError('fetch failed');
      return jwks();
    });
    const jwt = await accessJwt();
    expect(await r.status(jwt)).toBe(503);
    expect(r.logs.at(-1)?.kind).toBe('certs');
    for (let i = 0; i < 5; i++) expect(await r.status(jwt)).toBe(503);
    r.clock.t += 29_000;
    expect(await r.status(jwt)).toBe(503);
    expect(r.calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
    down = false;
    r.clock.t += 2_000;
    expect(await r.status(jwt)).toBe(200);
    expect(r.calls).toHaveLength(2);
    expect(await r.status(jwt)).toBe(200);
    expect(r.calls).toHaveLength(2);
  });

  it.each([
    ['non-200', () => new Response('nope', { status: 500 })],
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['not a key set', () => Response.json({ hello: 1 })],
  ])('%s from the certs URL -> 503 certs', async (_n, make) => {
    const r = await rig(() => make());
    expect(await r.status(await accessJwt())).toBe(503);
    expect(r.logs.at(-1)?.kind).toBe('certs');
  });

  it('unknown kid with a good key set -> 401 (no 503, no negative cache)', async () => {
    const r = await rig(() => jwks());
    expect(await r.status(await accessJwt({ kid: 'kid-rotated-away' }))).toBe(401);
    expect(r.logs.at(-1)?.kind).toBe('invalid');
    // The good set stays usable right away.
    expect(await r.status(await accessJwt())).toBe(200);
  });

  it('unknown kid whose refetch fails -> 503 certs', async () => {
    let n = 0;
    const r = await rig(() => {
      n += 1;
      if (n > 1) throw new TypeError('fetch failed');
      return jwks();
    });
    expect(await r.status(await accessJwt())).toBe(200);
    // jose refetches on an unknown kid only after its 30 s cooldown (real clock).
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      expect(await r.status(await accessJwt({ kid: 'kid-new' }))).toBe(503);
    } finally {
      Date.now = realNow;
    }
    expect(n).toBe(2);
  });
});

describe('bypass vs protected path matrix', () => {
  it('the exact bypass paths need no JWT: POST /ingest with the Bearer stores; /bridge reaches the bridge route (its own token check, V1-04)', async () => {
    const r = startRig();
    expect((await r.post(makeEvent(1))).status).toBe(204);
    expect(r.stored()).toHaveLength(1);
    const res = await r.fetch('/bridge');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'Missing or invalid token' } });
    expect((await r.fetch('/ingest')).status).toBe(405);
  });

  it.each([
    '/',
    '/api/health',
    '/api/sessions',
    '/ws/ui',
    '/%69ngest',
    '/%69NGEST',
    '/ingest%2f',
    '/INGEST',
    '/Ingest',
    '/ingest/',
    '/ingest/x',
    '/ingest;x',
    '/ingestx',
    '/ingest.json',
    '//ingest',
    '/ingest/%2e%2e/api/health',
    '/bridge/',
    '/%62ridge',
    '/BRIDGE',
    '/bridge/../api/health',
    '/ingest/../api/health',
    '/api/%68ealth',
  ])('%s without a JWT -> 401 (POST with the ingest Bearer too); nothing stored', async (path) => {
    const r = startRig();
    expect((await r.fetch(path)).status).toBe(401);
    const res = await r.fetch(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify(makeEvent(1)),
    });
    expect(res.status).toBe(401);
    expect(r.stored()).toHaveLength(0);
  });

  it.each(['/%69ngest', '/ingest/', '/INGEST', '/api/%68ealth', '//ingest'])(
    '%s with a valid JWT never reaches a handler by its decoded name (404, nothing stored)',
    async (path) => {
      const r = startRig();
      const headers = { [H]: await accessJwt(), authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', origin: BASE };
      expect((await r.fetch(path, { headers })).status).toBe(404);
      expect((await r.fetch(path, { method: 'POST', headers, body: JSON.stringify(makeEvent(1)) })).status).toBe(404);
      expect(r.stored()).toHaveLength(0);
    },
  );

  it('dot segments are resolved first: /api/../ingest is the bypass path (token-checked handler)', async () => {
    const r = startRig();
    const res = await r.fetch('/api/../ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(r.logs.at(-1)?.route).toBe('ingest');
  });
});

describe('AC: Origin on state-changing requests and WS upgrades', () => {
  const jwtHeaders = async (extra: Record<string, string>): Promise<Record<string, string>> => ({ [H]: await accessJwt(), ...extra });

  it.each([
    ['no Origin', {}],
    ['other site', { origin: 'https://evil.example' }],
    ['"null" origin', { origin: 'null' }],
    ['http scheme', { origin: `http://${HOST}` }],
    ['other port', { origin: `${BASE}:8443` }],
    ['sub-domain', { origin: `https://x.${HOST}` }],
    ['trailing slash', { origin: `${BASE}/` }],
  ])('POST with %s -> 403', async (_n, extra) => {
    const r = startRig();
    const res = await r.fetch('/api/commands', { method: 'POST', headers: await jwtHeaders({ 'content-type': 'application/json', ...extra }), body: '{}' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'bad_origin', message: 'Cross-origin request refused' } });
    expect(r.logs.at(-1)).toEqual({ route: 'access', status: 403, kind: 'origin' });
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s with another Origin -> 403', async (method) => {
    const r = startRig();
    expect((await r.fetch('/api/commands', { method, headers: await jwtHeaders({ origin: 'https://evil.example' }) })).status).toBe(403);
  });

  it('POST with our own Origin passes the guard (404: no such route yet)', async () => {
    const r = startRig();
    expect((await r.fetch('/api/commands', { method: 'POST', headers: await jwtHeaders({ origin: BASE }), body: '{}' })).status).toBe(404);
  });

  it('WebSocket upgrade: other or missing Origin -> 403; own Origin passes the guard', async () => {
    const r = startRig();
    const ws = { upgrade: 'websocket', connection: 'Upgrade' };
    expect((await r.fetch('/ws/ui', { headers: await jwtHeaders({ ...ws, origin: 'https://evil.example' }) })).status).toBe(403);
    expect((await r.fetch('/ws/ui', { headers: await jwtHeaders({ ...ws, upgrade: 'WebSocket' }) })).status).toBe(403);
    expect((await r.fetch('/ws/ui', { headers: await jwtHeaders({ ...ws, origin: BASE }) })).status).toBe(200); // fake DO upgrade (V1-03)
    expect(r.upgrades).toHaveLength(1);
  });

  it('WebSocket upgrade without a JWT -> 401 (checked before Origin)', async () => {
    const r = startRig();
    expect((await r.fetch('/ws/ui', { headers: { upgrade: 'websocket', origin: BASE } })).status).toBe(401);
  });

  it('plain GET needs no Origin', async () => {
    const r = startRig();
    expect((await r.fetch('/api/health', { headers: await jwtHeaders({}) })).status).toBe(200);
    expect((await r.fetch('/api/health', { headers: await jwtHeaders({ origin: 'https://evil.example' }) })).status).toBe(200);
  });
});

describe('AC: CSP and security headers, no CORS', () => {
  const CSP = contentSecurityPolicy(HOST);

  it('the CSP is the plan §11 policy with connect-src narrowed to this host', () => {
    expect(CSP).toBe(
      "default-src 'self'; connect-src 'self' wss://agent-office.example.workers.dev; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(CSP).not.toMatch(/unsafe|\*|wss:(?!\/\/)/);
  });

  it('every response (200, 204, 401, 403, 404, 405, 503) carries CSP + security headers and no Access-Control-*', async () => {
    const r = startRig();
    const jwt = await accessJwt();
    const responses = [
      await get(r, '/api/health', jwt),
      await r.post(makeEvent(1)),
      await get(r, '/'),
      await get(r, '/api/health', await accessJwt({ claims: { email: 'x@example.com' } })),
      await r.fetch('/x', { method: 'POST', headers: { [H]: jwt, origin: 'https://evil.example' } }),
      await get(r, '/nope', jwt),
      await r.fetch('/ingest'),
      await r.fetch('/api/health', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }),
      await startRig({ INGEST_TOKEN: TOKEN }).fetch('/api/health'),
    ];
    expect(responses.map((x) => x.status)).toEqual([200, 204, 401, 403, 403, 404, 405, 401, 503]);
    for (const res of responses) {
      expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
      expect(res.headers.get('content-security-policy')).toBe(CSP);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
    }
  });
});
