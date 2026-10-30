// Cloudflare Access JWT verification (plan §11 layer 1, FR-019, V1-02).
//
// Access sits in front of the Worker, but the Worker checks the JWT itself as well
// (defence in depth: a misconfigured or removed Access app must not open the relay).
// Only the `Cf-Access-Jwt-Assertion` header is read. Access adds it to every request
// it lets through (WebSocket upgrades too); the CF_Authorization cookie is NOT used.
//
// Checks: RS256 signature against the team certs (JWKS, cached per isolate),
// iss = https://<ACCESS_TEAM_DOMAIN>, aud contains ACCESS_AUD, exp (required) and
// nbf with a small clock tolerance, and the email claim in ACCESS_ALLOWED_EMAILS.
// Any key-source failure (network, non-200, timeout, bad set) is 503 "certs"; an
// unknown kid with a good key set stays 401.
// Missing or malformed config fails closed (503); the JWT is never logged.
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/** Access signs with RS256 only; anything else (none, HS256, ES256...) is refused. */
export const ACCESS_ALGORITHMS = ['RS256'];
export const CLOCK_TOLERANCE_SEC = 30;
export const JWT_HEADER = 'cf-access-jwt-assertion';
/** Real Access JWTs are ~1 KB; a cap keeps the parser away from huge headers. */
export const MAX_JWT_LENGTH = 8192;

// Team domain: "<team>.cloudflareaccess.com" only. The JWKS URL is built from it, so
// this is also the SSRF guard (the relay never fetches any other host for certs).
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
// The AUD tag is a 64-hex string today; accept a bounded token charset in case it changes.
const AUD = /^[A-Za-z0-9_-]{16,256}$/;
const EMAIL = /^[^\s@,]{1,64}@[^\s@,]{1,255}$/;

export interface AccessBindings {
  /** Secret: e.g. example.cloudflareaccess.com (an https:// prefix or trailing "/" is tolerated). */
  readonly ACCESS_TEAM_DOMAIN?: string;
  /** Secret: the Application Audience (AUD) tag of the "agent-office - Cloudflare Workers" Access app. */
  readonly ACCESS_AUD?: string;
  /** Var (wrangler.jsonc): comma-separated emails allowed in (plan D1: the PO email only). */
  readonly ACCESS_ALLOWED_EMAILS?: string;
}

export interface AccessConfig {
  readonly teamDomain: string;
  readonly issuer: string;
  readonly certsUrl: string;
  readonly audience: string;
  readonly emails: ReadonlySet<string>;
}

/** Parses the Access settings, or null when any is missing or malformed (callers answer 503). */
export function accessConfig(env: AccessBindings): AccessConfig | null {
  const rawDomain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  const audience = env.ACCESS_AUD?.trim();
  if (!rawDomain || !TEAM_DOMAIN.test(rawDomain) || !audience || !AUD.test(audience)) return null;
  const emails = new Set(
    (env.ACCESS_ALLOWED_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
  if (emails.size === 0 || [...emails].some((e) => !EMAIL.test(e))) return null;
  return {
    teamDomain: rawDomain,
    issuer: `https://${rawDomain}`,
    certsUrl: `https://${rawDomain}/cdn-cgi/access/certs`,
    audience,
    emails,
  };
}

export type KeySource = (config: AccessConfig) => JWTVerifyGetKey;

/** After a failed certs fetch, answer 503 for this long without refetching (per isolate). */
export const CERTS_RETRY_MS = 30 * 1000;

/** The key source could not give keys (network, non-200, bad JSON, timeout, bad set). */
export class CertsUnavailable extends Error {
  constructor(cause?: unknown) {
    super('Access certs unavailable', { cause });
    this.name = 'CertsUnavailable';
  }
}

/**
 * Errors that come from the TOKEN, not from the key set: a good set with no key (or
 * several keys) for the token's kid. Everything else a key source throws is a certs
 * problem (503). jose checks `alg` against ACCESS_ALGORITHMS before it asks for a
 * key, so only RS256 tokens ever reach the key source.
 */
export function isTokenKeyError(err: unknown): boolean {
  return err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSMultipleMatchingKeys;
}

export interface RemoteKeysOptions {
  /** Test seam: replaces the global fetch for the certs request. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

interface RemoteEntry {
  readonly set: JWTVerifyGetKey;
  failedUntil: number;
}

/**
 * One remote JWKS per team domain per isolate. jose caches the keys (cacheMaxAge),
 * refetches on an unknown kid at most once per cooldown, and times out the fetch.
 * On top: a failed fetch makes every request for the next CERTS_RETRY_MS a 503
 * without a new fetch, so a certs outage cannot turn into a fetch storm.
 */
export function makeRemoteKeys(opts: RemoteKeysOptions = {}): KeySource {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, RemoteEntry>();
  return (config) => {
    let entry = entries.get(config.certsUrl);
    if (!entry) {
      const set = createRemoteJWKSet(new URL(config.certsUrl), {
        cacheMaxAge: 10 * 60 * 1000,
        cooldownDuration: 30 * 1000,
        timeoutDuration: 5000,
        ...(opts.fetch ? { [customFetch]: opts.fetch } : {}),
      });
      entry = { set, failedUntil: 0 };
      entries.set(config.certsUrl, entry);
    }
    const e = entry;
    return async (header, token) => {
      if (now() < e.failedUntil) throw new CertsUnavailable();
      try {
        return await e.set(header, token);
      } catch (err) {
        if (!isTokenKeyError(err)) e.failedUntil = now() + CERTS_RETRY_MS;
        throw err;
      }
    };
  };
}

export const remoteKeys: KeySource = makeRemoteKeys();

/** Turns every key-source error that is not about the token into CertsUnavailable. */
function classifyKeyErrors(getKey: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (header, token) => {
    try {
      return await getKey(header, token);
    } catch (err) {
      throw isTokenKeyError(err) || err instanceof CertsUnavailable ? err : new CertsUnavailable(err);
    }
  };
}

export type AccessResult =
  | { readonly ok: true; readonly email: string; /** JWT `exp` in ms (V1-03: UI sockets close then). */ readonly expMs: number }
  | { readonly ok: false; readonly status: 401 | 403 | 503; readonly reason: AccessFailure };

export type AccessFailure = 'missing' | 'invalid' | 'expired' | 'email' | 'certs';

/** Verifies the Access JWT from the request headers. Never throws. */
export async function verifyAccess(
  headers: Headers,
  config: AccessConfig,
  keys: KeySource,
  now: () => number,
): Promise<AccessResult> {
  const token = headers.get(JWT_HEADER)?.trim();
  if (!token) return { ok: false, status: 401, reason: 'missing' };
  if (token.length > MAX_JWT_LENGTH) return { ok: false, status: 401, reason: 'invalid' };
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, classifyKeyErrors(keys(config)), {
      algorithms: ACCESS_ALGORITHMS,
      issuer: config.issuer,
      audience: config.audience,
      requiredClaims: ['exp', 'iat'],
      clockTolerance: CLOCK_TOLERANCE_SEC,
      currentDate: new Date(now()),
    }));
  } catch (err) {
    if (err instanceof errors.JWTExpired) return { ok: false, status: 401, reason: 'expired' };
    // The certs could not be fetched: a server-side problem, still fail closed.
    if (err instanceof CertsUnavailable) {
      return { ok: false, status: 503, reason: 'certs' };
    }
    return { ok: false, status: 401, reason: 'invalid' };
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email || !config.emails.has(email)) return { ok: false, status: 403, reason: 'email' };
  // exp is a required claim and jose checked it is a number in the future.
  return { ok: true, email, expMs: (payload.exp ?? 0) * 1000 };
}
