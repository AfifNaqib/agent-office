// The PC data folder (`AGENT_OFFICE_HOME` or `~/.agent-office`): local token, config.json,
// and the user copy of the emit script. Mirrors packages/emit and packages/bridge:
// same folder rule, same token shape, same config keys.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { EMIT_NAME } from './hooks-merge.mjs';
import { SettingsError, parseJsonObject, readTextFile, serialize, writeAtomic } from './settings-file.mjs';
import { genToken } from './token.mjs';

export const DEFAULT_PORT = 47821; // same as packages/emit DEFAULT_BRIDGE_PORT (checked by a test)
export const TOKEN_FILE = 'local-token';
export const CONFIG_FILE = 'config.json';
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const MAX_TOKEN_BYTES = 1024;
const MAX_CONFIG_BYTES = 64 * 1024;

const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export function homeOf(env) {
  return nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME) ?? homedir();
}
export function dataDirOf(env) {
  return nonEmpty(env.AGENT_OFFICE_HOME) ?? join(homeOf(env), '.agent-office');
}
export function claudeDirOf(env) {
  return nonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(homeOf(env), '.claude');
}
export const userEmitPath = (dataDir) => join(dataDir, 'hooks', EMIT_NAME);

/** Where claude.exe normally lives for the PO; null off Windows. Never invents a different path. */
export function defaultClaudePath(env, platform) {
  const profile = nonEmpty(env.USERPROFILE);
  return platform === 'win32' && profile ? win32.join(profile, '.local', 'bin', 'claude.exe') : null;
}

/**
 * Look at the token file without changing anything: 'create' (missing) or 'keep' (valid).
 * Throws SettingsError for anything else (wrong shape, not a regular file): never overwritten.
 */
export function checkToken(dataDir) {
  const file = join(dataDir, TOKEN_FILE);
  const text = readTextFile(file, MAX_TOKEN_BYTES);
  if (text === null) {
    // ENOENT also happens for a dangling symlink: that is not "missing", never follow or replace it.
    let present = false;
    try {
      lstatSync(file);
      present = true;
    } catch {
      // really missing
    }
    if (present) throw new SettingsError(`${file} exists but cannot be read (a dangling link?); fix or remove it, nothing was changed`);
    return 'create';
  }
  if (!TOKEN_RE.test(text.trim())) throw new SettingsError(`${file} does not hold a valid token (16 to 256 characters of A-Z a-z 0-9 _ -); fix or remove it, nothing was changed`);
  return 'keep';
}

/** Create the token file (0600 where that means something) unless it is already valid. Never prints or returns the token. */
export function ensureToken(dataDir) {
  const status = checkToken(dataDir);
  if (status === 'keep') return 'kept';
  const file = join(dataDir, TOKEN_FILE);
  try {
    writeFileSync(file, `${genToken()}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      checkToken(dataDir); // someone created it first: it must be valid
      return 'kept';
    }
    throw new SettingsError(`cannot create ${file} (${err?.code ?? 'error'})`);
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ACLs: the user-profile folder is already user-only.
  }
  return 'created';
}

/**
 * What config.json should contain: the existing file's keys, plus `port` and `claudePath` when they are missing.
 * `claudePath` is only added when `fileExists(candidate)`. Returns { config, changed, warnings }.
 * Throws SettingsError for an existing file that is not a JSON object (never overwritten).
 */
export function planConfig(dataDir, { env, platform, fileExists = existsSync }) {
  const file = join(dataDir, CONFIG_FILE);
  const text = readTextFile(file, MAX_CONFIG_BYTES);
  const current = text === null ? {} : parseJsonObject(text, file);
  const next = { ...current };
  const warnings = [];
  if (next.port === undefined) next.port = DEFAULT_PORT;
  if (next.claudePath === undefined) {
    const candidate = defaultClaudePath(env, platform);
    if (candidate && fileExists(candidate)) next.claudePath = candidate;
    else if (candidate) warnings.push(`claude.exe not found at ${candidate}; claudePath left out. Add "claudePath": "<full path to claude.exe>" to ${file} before the control features (V2).`);
    else warnings.push(`claudePath not set in ${file}. It is only needed for the control features (V2); add the full path to the claude executable then.`);
  }
  return { file, text, config: next, changed: JSON.stringify(next) !== JSON.stringify(current), warnings };
}

export function writeConfig(plan) {
  writeAtomic(plan.file, serialize(plan.config, plan.text));
}

/** Copy `src` to `dest` through a temp file + rename, so a running hook never reads half a script. */
export function copyEmit(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.agent-office-tmp-${process.pid}`;
  try {
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never created
    }
    throw err;
  }
}
