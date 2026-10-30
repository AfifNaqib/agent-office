// Bridge configuration: `<data dir>/config.json` (optional) and `<data dir>/local-token`.
// V1-04: `relayUrl` + `bridgeToken` in config.json turn on forwarding to the relay
// (plan §11: BRIDGE_TOKEN lives only in config.json and the Worker secret). Both or
// neither; without them the bridge stays local only.
// Data dir = AGENT_OFFICE_HOME, else ~/.agent-office (same rule as the emit script).
// The token file is created (0600, best effort on Windows) with the shared token helper
// when missing. A token file that exists but is malformed stops the bridge: it is
// never overwritten silently. Error messages never contain file contents.
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { z } from 'zod';
import { genToken } from '../../../scripts/lib/token.mjs';

export const DEFAULT_PORT = 47821;
export const TOKEN_FILE = 'local-token';
export const CONFIG_FILE = 'config.json';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface BridgeConfig {
  readonly dataDir: string;
  readonly eventsDir: string;
  readonly tokenFile: string;
  /** Listening port. 0 = pick a free one (tests). */
  readonly port: number;
  /** Absolute path of the `claude` executable (the PO's PATH is locked). Unused until V2. */
  readonly claudePath: string | undefined;
  readonly token: string;
  /** Relay forwarding (V1-04); undefined = off. */
  readonly relay: RelayConfig | undefined;
}

export interface RelayConfig {
  /** wss://<host>/bridge (ws:// only for a loopback relay in tests). */
  readonly url: string;
  /** For logs: the relay host only. */
  readonly host: string;
  /** BRIDGE_TOKEN. Never logged, never sent anywhere but the relay's /bridge upgrade. */
  readonly token: string;
}

const BRIDGE_TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** https://host (any host) or http://<loopback>:port; origin only (no user, path, query or fragment). */
export function relaySocketUrl(raw: string): { url: string; host: string } | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || (u.pathname !== '/' && u.pathname !== '')) return undefined;
  if (u.protocol === 'https:') return { url: `wss://${u.host}/bridge`, host: u.host };
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return { url: `ws://${u.host}/bridge`, host: u.host };
  return undefined;
}

const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f]*$/, 'no control characters')
  .refine((p) => posix.isAbsolute(p) || win32.isAbsolute(p), 'must be an absolute path');

// Loose: other keys (repos for V2) are allowed.
const ConfigFileSchema = z.looseObject({
  port: z.number().int().min(1024).max(65535).optional(),
  claudePath: absolutePath.optional(),
  eventsDir: absolutePath.optional(),
  relayUrl: z
    .string()
    .max(512)
    .refine((v) => relaySocketUrl(v) !== undefined, 'https://<relay host> only')
    .optional(),
  bridgeToken: z.string().regex(BRIDGE_TOKEN_RE, '32 to 256 characters of A-Z a-z 0-9 _ -').optional(),
});

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

export function dataDirOf(env: Env): string {
  const override = nonEmpty(env.AGENT_OFFICE_HOME);
  if (override) return override;
  return join(nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME) ?? homedir(), '.agent-office');
}

/** Valid AGENT_OFFICE_BRIDGE_PORT (the emit script reads the same variable), else undefined. */
function envPort(env: Env): number | undefined {
  const raw = nonEmpty(env.AGENT_OFFICE_BRIDGE_PORT);
  if (raw === undefined || !/^\d{1,5}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : undefined;
}

type ReadResult = { readonly kind: 'missing' } | { readonly kind: 'text'; readonly text: string } | { readonly kind: 'bad' };

/** Open non-blocking, fstat the descriptor, regular file only, size-bounded (same idea as the emit script's B-04 fix). */
function readSmallFile(file: string, maxBytes: number): ReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | ((constants.O_NONBLOCK as number | undefined) ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return { kind: 'bad' };
    const buf = Buffer.alloc(st.size);
    let len = 0;
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
    }
    return { kind: 'text', text: buf.toString('utf8', 0, len) };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'bad' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function bestEffortChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows ACLs / unusual filesystems: the user-profile folder is already user-only there.
  }
}

function loadToken(file: string): string {
  const first = readSmallFile(file, MAX_TOKEN_BYTES);
  if (first.kind === 'text') return validToken(first.text);
  if (first.kind === 'bad') throw new ConfigError(`${TOKEN_FILE} is not a readable regular file; fix or remove it`);
  const fresh = genToken();
  try {
    writeFileSync(file, `${fresh}\n`, { flag: 'wx', mode: 0o600 });
    bestEffortChmod(file, 0o600);
    return fresh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConfigError(`cannot create ${TOKEN_FILE}`);
    // Someone (a second bridge, the setup script) created it between our read and write.
    const again = readSmallFile(file, MAX_TOKEN_BYTES);
    if (again.kind !== 'text') throw new ConfigError(`${TOKEN_FILE} is not a readable regular file; fix or remove it`);
    return validToken(again.text);
  }
}

function validToken(text: string): string {
  const t = text.trim();
  if (!TOKEN_RE.test(t)) throw new ConfigError(`${TOKEN_FILE} does not hold a valid token (16 to 256 characters of A-Z a-z 0-9 _ -); fix or remove it`);
  return t;
}

function loadFile(file: string): z.infer<typeof ConfigFileSchema> {
  const r = readSmallFile(file, MAX_CONFIG_BYTES);
  if (r.kind === 'missing') return {};
  if (r.kind === 'bad') throw new ConfigError(`${CONFIG_FILE} is not a readable regular file under 64 KB`);
  let json: unknown;
  try {
    // A leading UTF-8 BOM (PowerShell 5.1 `Set-Content -Encoding UTF8` writes one) is ignored, as in the installer.
    json = JSON.parse(r.text.charCodeAt(0) === 0xfeff ? r.text.slice(1) : r.text);
  } catch {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON`);
  }
  const parsed = ConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new ConfigError(`${CONFIG_FILE} is invalid at: ${where}`);
  }
  return parsed.data;
}

/** Reads (and when needed creates) the bridge's files. Throws ConfigError with a message that is safe to print. */
export function loadConfig(env: Env): BridgeConfig {
  const dataDir = dataDirOf(env);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch {
    throw new ConfigError('cannot create the data folder');
  }
  const file = loadFile(join(dataDir, CONFIG_FILE));
  const tokenFile = join(dataDir, TOKEN_FILE);
  const relay = relayConfig(file);
  const token = loadToken(tokenFile);
  // The local token must never leave the PC; refusing the same value keeps a copy-paste slip from sending it.
  if (relay && relay.token === token) throw new ConfigError(`${CONFIG_FILE}: bridgeToken must be the relay's BRIDGE_TOKEN, not the ${TOKEN_FILE}`);
  return {
    dataDir,
    eventsDir: file.eventsDir ?? join(dataDir, 'events'),
    tokenFile,
    port: envPort(env) ?? file.port ?? DEFAULT_PORT,
    claudePath: file.claudePath,
    token,
    relay,
  };
}

function relayConfig(file: z.infer<typeof ConfigFileSchema>): RelayConfig | undefined {
  if (file.relayUrl === undefined && file.bridgeToken === undefined) return undefined;
  if (file.relayUrl === undefined || file.bridgeToken === undefined) {
    throw new ConfigError(`${CONFIG_FILE}: set both relayUrl and bridgeToken, or neither`);
  }
  const target = relaySocketUrl(file.relayUrl);
  if (!target) throw new ConfigError(`${CONFIG_FILE} is invalid at: relayUrl`);
  return { ...target, token: file.bridgeToken };
}

