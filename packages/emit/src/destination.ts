// Where an event goes (FR-002) and with what credentials. Pure except for the
// token file read, which is injected.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Source } from '@agent-office/core';
import { CONFIG_FILE } from './portfile.js';

export type Env = Readonly<Record<string, string | undefined>>;

export interface Destination {
  readonly source: Source;
  readonly url: string;
  /** Extra request headers. Never contains a Claude credential. */
  readonly headers: Readonly<Record<string, string>>;
}

export const DEFAULT_BRIDGE_PORT = 47821;
/** Bridge listens on loopback only (plan §11, MUST NOT 2). The host is never configurable. */
export const BRIDGE_HOST = '127.0.0.1';
export const LOCAL_PATH = '/hooks/event';
export const CLOUD_PATH = '/ingest';
export const LOCAL_TOKEN_HEADER = 'X-Agent-Office-Local';
export const LOCAL_TOKEN_FILE = 'local-token';
/** gen-token writes 43 base64url characters; allow some slack. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

/** %USERPROFILE%\.agent-office (PC setup, FR-031). AGENT_OFFICE_HOME overrides the folder (tests, portable installs). */
export function dataDir(env: Env): string {
  const override = nonEmpty(env.AGENT_OFFICE_HOME);
  if (override) return override;
  return join(nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME) ?? homedir(), '.agent-office');
}

/** AGENT_OFFICE_BRIDGE_PORT if it is a valid port (1 to 65535), else undefined. */
function envPort(env: Env): number | undefined {
  const raw = nonEmpty(env.AGENT_OFFICE_BRIDGE_PORT);
  const n = raw !== undefined && /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

/**
 * B-07, same order as the bridge: AGENT_OFFICE_BRIDGE_PORT, then `port` in
 * <data dir>/config.json, then 47821. config.json is only read when the variable
 * gives no valid port. Only the port is configurable, never the host.
 */
export function bridgePort(env: Env, readConfigPort: (file: string) => number | undefined = () => undefined): number {
  return envPort(env) ?? readConfigPort(join(dataDir(env), CONFIG_FILE)) ?? DEFAULT_BRIDGE_PORT;
}

/** PC: the local bridge. Needs the local token; without it nothing is sent. */
export function localDestination(
  env: Env,
  readToken: (file: string) => string | undefined,
  readConfigPort?: (file: string) => number | undefined,
): Destination | null {
  const raw = readToken(join(dataDir(env), LOCAL_TOKEN_FILE))?.trim();
  if (raw === undefined || !TOKEN_RE.test(raw)) return null;
  return {
    source: 'local',
    url: `http://${BRIDGE_HOST}:${bridgePort(env, readConfigPort)}${LOCAL_PATH}`,
    headers: { [LOCAL_TOKEN_HEADER]: raw },
  };
}

/**
 * Relay ingest URL from AGENT_OFFICE_RELAY_URL: https only (plain http only for
 * loopback, for tests), no credentials in the URL, query and fragment dropped.
 * Returns null for anything else, so a bad value sends nothing.
 */
export function relayIngestUrl(value: string | undefined): string | null {
  const v = nonEmpty(value);
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.username !== '' || u.password !== '') return null;
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname));
  if (!ok) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${CLOUD_PATH}`;
}

/**
 * Cloud: POST $AGENT_OFFICE_RELAY_URL/ingest.
 *
 * This script carries NO credential (plan §11 item 2, confirmed by spike S1):
 * the cloud environment's network secret adds `Authorization: Bearer
 * <INGEST_TOKEN>` for the relay host, but only to traffic that goes through the
 * egress proxy. Node `fetch` uses the proxy only with NODE_USE_ENV_PROXY=1, so
 * emit re-runs itself with that flag in the cloud (reexec.ts, plan A3.1). No
 * header is added here and no token is read from the environment.
 */
export function cloudDestination(env: Env): Destination | null {
  const url = relayIngestUrl(env.AGENT_OFFICE_RELAY_URL);
  return url ? { source: 'cloud', url, headers: {} } : null;
}

/** FR-002: a non-empty CLAUDE_CODE_REMOTE_SESSION_ID means a cloud session. */
export function isCloud(env: Env): boolean {
  return nonEmpty(env.CLAUDE_CODE_REMOTE_SESSION_ID) !== undefined;
}

/**
 * FR-002: CLAUDE_CODE_REMOTE_SESSION_ID set -> cloud (relay). Otherwise -> the
 * local bridge. Missing configuration -> null (the caller exits 0 silently). A
 * cloud session never falls back to 127.0.0.1: that is the container itself.
 */
export function resolveDestination(
  env: Env,
  readToken: (file: string) => string | undefined,
  readConfigPort?: (file: string) => number | undefined,
): Destination | null {
  return isCloud(env) ? cloudDestination(env) : localDestination(env, readToken, readConfigPort);
}
