// Logic for `npm run secrets:check` and `npm run deploy:relay` (V1-07).
//
// Everything that touches the outside world goes through a `run(cmd, args, opts)`
// function that the CLIs pass in, so tests use a fake runner and never call
// Cloudflare or git. Secret VALUES are never read: `wrangler secret list` only
// returns names, and only names are ever printed.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RELAY_DIR = join(REPO_ROOT, 'packages', 'relay');
/** The office web app; its build (dist/) is the relay's static assets (V1-05). */
export const WEB_DIR = join(REPO_ROOT, 'packages', 'web');

/** Secrets the deployed relay needs today. Missing = error. */
export const REQUIRED_SECRETS = [
  { name: 'INGEST_TOKEN', use: 'POST /ingest (cloud hooks)' },
  { name: 'ACCESS_TEAM_DOMAIN', use: 'Access JWT issuer + certs (V1-02)' },
  { name: 'ACCESS_AUD', use: 'Access JWT audience (V1-02)' },
  { name: 'BRIDGE_TOKEN', use: 'GET /bridge (the PC bridge socket, V1-04)' },
];

/** Secrets later tasks will need. Missing = warning only, until those tasks land. */
/** @type {{ name: string, task: string }[]} (ROUTINES_JSON joins with V2.) */
export const LATER_SECRETS = [];

/** Same minimum as the root package.json `engines` (wrangler 4 needs 22+). */
export const MIN_NODE = '22.13.0';
const [MIN_MAJOR, MIN_MINOR] = MIN_NODE.split('.').map(Number);

/** Paths whose untracked files change what gets deployed (wrangler bundles relay + core source, plus the web build as assets). */
export const DEPLOYED_PREFIXES = ['packages/relay/', 'packages/core/', 'packages/web/'];

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** True when `version` (e.g. "v20.11.1") is older than MIN_NODE (major.minor). */
export function nodeTooOld(version = process.version) {
  const m = /^v?(\d+)\.(\d+)\./.exec(version);
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR);
}

/**
 * Parses the stdout of `wrangler secret list --format json`: a JSON array of
 * `{ name, type }`. Wrangler may print other lines around it, so the array is taken
 * from the first line that starts with `[` to the last `]`. Returns the names only.
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseSecretList(stdout) {
  const lines = String(stdout).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimStart().startsWith('['));
  if (start < 0) throw new Error('wrangler output has no JSON list');
  const text = lines.slice(start).join('\n');
  const end = text.lastIndexOf(']');
  if (end < 0) throw new Error('wrangler output has no JSON list');
  let data;
  try {
    data = JSON.parse(text.slice(0, end + 1));
  } catch {
    throw new Error('wrangler output is not valid JSON');
  }
  if (!Array.isArray(data)) throw new Error('wrangler output is not a list');
  const names = [];
  for (const item of data) {
    const name = item && typeof item === 'object' ? item.name : undefined;
    if (typeof name !== 'string' || !SECRET_NAME.test(name)) {
      throw new Error('wrangler output has an entry without a valid secret name');
    }
    names.push(name);
  }
  return names;
}

/**
 * @param {string[]} names secret names present on the Worker
 * @returns {{ missing: string[], later: {name: string, task: string}[], ok: boolean }}
 */
export function evaluateSecrets(names) {
  const have = new Set(names);
  const missing = REQUIRED_SECRETS.filter((s) => !have.has(s.name)).map((s) => s.name);
  const later = LATER_SECRETS.filter((s) => !have.has(s.name));
  return { missing, later, ok: missing.length === 0 };
}

/**
 * Parses `git status --porcelain=v1 -z`. Renames/copies carry a second (source) path,
 * which is skipped.
 * @param {string} z
 * @returns {{ code: string, path: string }[]}
 */
export function parseGitStatus(z) {
  const parts = String(z).split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    entries.push({ code, path: p.slice(3) });
    if (code.includes('R') || code.includes('C')) i++;
  }
  return entries;
}

/**
 * Paths that make the tree "dirty" for a deploy: every change to a tracked file,
 * and untracked files inside the deployed source (packages/relay, packages/core).
 * Untracked files elsewhere (e.g. a local graphify-out/) do not block a deploy.
 * @param {{ code: string, path: string }[]} entries
 */
export function dirtyPaths(entries) {
  return entries
    .filter((e) =>
      e.code === '??' ? DEPLOYED_PREFIXES.some((p) => e.path.startsWith(p)) : e.code !== '!!',
    )
    .map((e) => e.path);
}

/**
 * Parses `git ls-files -v -z`: each entry is "<tag> <path>". Returns the paths git
 * is told to ignore changes to: assume-unchanged (lowercase tag) or skip-worktree
 * (`S`). Changes to those files are hidden from `git status`, so a deploy could
 * ship code that is not the commit.
 * @param {string} z
 * @returns {string[]}
 */
export function hiddenChangePaths(z) {
  const paths = [];
  for (const p of String(z).split('\0')) {
    if (p.length < 3 || p[1] !== ' ') continue;
    const tag = p[0];
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) paths.push(p.slice(2));
  }
  return paths;
}

/** Wrangler's redirect file: if present, `wrangler deploy` uses ITS config, not wrangler.jsonc. */
export const REDIRECT_CONFIG = join(RELAY_DIR, '.wrangler', 'deploy', 'config.json');

/** Finds wrangler's JS entry (run with node directly: works with a locked PATH). */
export function findWrangler() {
  try {
    const req = createRequire(join(RELAY_DIR, 'package.json'));
    const bin = join(dirname(req.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** Finds vite's JS entry for the web build (run with node directly, like wrangler). */
export function findVite() {
  try {
    const req = createRequire(join(WEB_DIR, 'package.json'));
    const bin = join(dirname(req.resolve('vite/package.json')), 'bin', 'vite.js');
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/**
 * Real runner: spawnSync with shell:false. `capture` collects stdout/stderr,
 * otherwise the child shares this terminal (so wrangler prompts still work).
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, capture?: boolean }} [opts]
 */
export function realRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    shell: false,
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ? r.error.message : undefined,
  };
}

/**
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, capture?: boolean }) =>
 *   { status: number | null, stdout: string, stderr: string, error?: string }} Runner
 * @typedef {{ run: Runner, log: (s: string) => void, err: (s: string) => void,
 *   wrangler: string | null, vite?: string | null, nodeVersion?: string,
 *   exists?: (p: string) => boolean }} Deps
 */

function wranglerArgs(deps, args) {
  return [deps.wrangler ?? '', ...args];
}

function preflight(deps) {
  if (nodeTooOld(deps.nodeVersion)) {
    deps.err(
      `error: Node ${deps.nodeVersion ?? process.version} is too old; wrangler needs Node ${MIN_NODE} or newer. Install the current LTS from nodejs.org.`,
    );
    return false;
  }
  if (!deps.wrangler) {
    deps.err('error: wrangler not found. Run `npm ci` in the repo folder first.');
    return false;
  }
  return true;
}

/**
 * `npm run secrets:check`. Returns the exit code: 0 ok, 1 required secret missing,
 * 2 could not list secrets.
 * @param {Deps} deps
 */
export function secretsCheck(deps) {
  if (!preflight(deps)) return 2;
  const r = deps.run(process.execPath, wranglerArgs(deps, ['secret', 'list', '--format', 'json']), {
    cwd: RELAY_DIR,
    capture: true,
  });
  if (r.status !== 0) {
    deps.err('error: `wrangler secret list` failed.');
    if (r.error) deps.err(r.error);
    const tail = r.stderr.trim().split(/\r?\n/).slice(-8).join('\n');
    if (tail) deps.err(tail);
    deps.err(
      'hint: not logged in? run wrangler login. Worker not found? put INGEST_TOKEN first (see docs/setup-cloudflare.md).',
    );
    return 2;
  }
  let names;
  try {
    names = parseSecretList(r.stdout);
  } catch (e) {
    deps.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const res = evaluateSecrets(names);
  for (const s of REQUIRED_SECRETS) {
    deps.log(`${res.missing.includes(s.name) ? 'MISSING' : 'ok     '} ${s.name}`);
  }
  for (const s of LATER_SECRETS) {
    const isMissing = res.later.some((l) => l.name === s.name);
    deps.log(isMissing ? `warning ${s.name} not set (needed from ${s.task})` : `ok      ${s.name}`);
  }
  if (!res.ok) {
    deps.err(`error: missing required secret(s): ${res.missing.join(', ')}`);
    return 1;
  }
  deps.log('secrets: ok');
  return 0;
}

/**
 * `npm run deploy:relay`. Refuses on a dirty tree or a failed secrets check, then
 * runs `wrangler deploy` in packages/relay. Returns the exit code.
 * @param {Deps} deps
 */
export function deployRelay(deps) {
  if (!preflight(deps)) return 2;
  if (!deps.vite) {
    deps.err('error: vite not found (needed to build the office web app). Run `npm ci` in the repo folder first.');
    return 2;
  }
  const st = deps.run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: REPO_ROOT,
    capture: true,
  });
  if (st.status !== 0) {
    deps.err('error: `git status` failed; deploy refused.');
    if (st.error) deps.err(st.error);
    return 2;
  }
  const dirty = dirtyPaths(parseGitStatus(st.stdout));
  if (dirty.length > 0) {
    deps.err('error: working tree is dirty; deploy refused. Commit or undo these first:');
    for (const p of dirty.slice(0, 20)) deps.err(`  ${p}`);
    if (dirty.length > 20) deps.err(`  ... and ${dirty.length - 20} more`);
    return 1;
  }
  const lf = deps.run('git', ['ls-files', '-v', '-z', '--', ...DEPLOYED_PREFIXES], {
    cwd: REPO_ROOT,
    capture: true,
  });
  if (lf.status !== 0) {
    deps.err('error: `git ls-files` failed; deploy refused.');
    if (lf.error) deps.err(lf.error);
    return 2;
  }
  const hidden = hiddenChangePaths(lf.stdout);
  if (hidden.length > 0) {
    deps.err(
      'error: files marked assume-unchanged or skip-worktree in the deployed source; deploy refused.',
    );
    deps.err('  Undo with: git update-index --no-assume-unchanged --no-skip-worktree <file>');
    for (const p of hidden.slice(0, 20)) deps.err(`  ${p}`);
    if (hidden.length > 20) deps.err(`  ... and ${hidden.length - 20} more`);
    return 1;
  }
  if ((deps.exists ?? existsSync)(REDIRECT_CONFIG)) {
    deps.err(
      'error: packages/relay/.wrangler/deploy/config.json exists (wrangler would deploy ITS config); deploy refused. Delete it if you did not make it on purpose.',
    );
    return 1;
  }
  const anc = deps.run('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], {
    cwd: REPO_ROOT,
    capture: true,
  });
  if (anc.status !== 0) {
    deps.err(
      anc.status === 1
        ? 'warning: this commit is not on origin/main (your local copy of it). Deploying anyway.'
        : 'warning: could not compare with origin/main. Deploying anyway.',
    );
    deps.err('  Meant to deploy main? Run `git pull` first, then `npm ci`, then deploy again.');
  }
  const check = secretsCheck(deps);
  if (check !== 0) {
    deps.err('error: secrets check failed; deploy refused.');
    return check;
  }
  const head = deps.run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO_ROOT, capture: true });
  const sha = head.status === 0 ? head.stdout.trim() : '';
  const msg = /^[0-9a-f]{7,40}$/.test(sha) ? ['--message', `git ${sha}`] : [];
  // V1-05: the relay serves packages/web/dist as its static assets, so build it from
  // this exact tree first (a stale or missing dist would deploy the wrong UI).
  deps.log('building the office web app (packages/web) ...');
  const web = deps.run(process.execPath, [deps.vite, 'build'], { cwd: WEB_DIR });
  if (web.status !== 0) {
    deps.err('error: web build failed; deploy refused.');
    if (web.error) deps.err(web.error);
    return web.status ?? 1;
  }
  deps.log(`deploying packages/relay${sha ? ` at ${sha}` : ''} ...`);
  const r = deps.run(process.execPath, wranglerArgs(deps, ['deploy', ...msg]), { cwd: RELAY_DIR });
  if (r.status !== 0) {
    deps.err('error: wrangler deploy failed.');
    if (r.error) deps.err(r.error);
    return r.status ?? 1;
  }
  deps.log('deployed. Check: <the workers.dev URL wrangler printed above>/api/health (401 until you log in through Access).');
  return 0;
}

/** Default deps for the CLIs. */
export function defaultDeps() {
  return {
    run: realRun,
    log: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    wrangler: findWrangler(),
    vite: findVite(),
    nodeVersion: process.version,
    exists: existsSync,
  };
}
