#!/usr/bin/env node
// Spike S3 (docs/spikes/S3.md): `claude -p` stream-json spawn, mid-run message,
// stop methods and resume on the PO's Windows PC. The PO runs it; the coder does not.
//
//   node scripts/spike-s3.mjs              -> step 1 only: find the claude executable (no model usage)
//   node scripts/spike-s3.mjs --run        -> all steps (6 short headless runs on the PO's own login)
//   node scripts/spike-s3.mjs --run --claude <path>   -> use this executable (or a cli.js, run with node)
//
// Rules this script keeps (build plan, "Coder MUST NOT change"):
// - Only the unmodified `claude` CLI. No Agent SDK, no --bare, no credentials read or stored.
// - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed from the child env (subscription login only).
// - spawn(..., { shell: false }); prompts go through stdin, never argv.
// - --permission-mode default; prompts ask for no tools. Never bypassPermissions.
// - The report holds env var PRESENCE only, hook event names (never hook bodies), reply
//   excerpts of at most 120 characters and the first 300 characters of stderr (error text). It goes to stdout and .spike/s3/report.json (gitignored).
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), '..');
export const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
export const STOP_WAIT_MS = 10_000; // FR-022: graceful stop, then kill after 10 s
const RUN_CAP_MS = 120_000;
const EXCERPT = 120;
const STDERR_HEAD = 300;

const PROMPTS = {
  count: 'Do not use any tools. Count from 1 to 40, one number per line.',
  second: 'Do not use any tools. Now reply with exactly: TWO',
  story: 'Do not use any tools. Write a 600-word story about a lighthouse keeper.',
  after: 'Do not use any tools. Reply with exactly: AFTER',
  resume: 'Do not use any tools. In five words or fewer: what were you writing before?',
};

// ---- pure helpers (unit-tested in scripts/test/spike-s3.test.mjs) ----

/** Copy of the env without API keys (case-insensitive, Windows env keys are), plus the run id. */
export function childEnv(parent, runId) {
  const drop = new Set(STRIPPED_ENV);
  const env = {};
  for (const [k, v] of Object.entries(parent)) if (!drop.has(k.toUpperCase())) env[k] = v;
  env.AGENT_OFFICE_RUN_ID = runId;
  return env;
}

export function claudeArgs(settingsPath, extra = []) {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'default', '--settings', settingsPath, ...extra];
}

export const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
export const interruptLine = (id) => JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } }) + '\n';

/** A .js/.mjs/.cjs path (npm's cli.js behind a .cmd shim) runs under this Node; anything else directly. */
export function spawnTarget(claudePath) {
  return /\.[cm]?js$/i.test(claudePath) ? { cmd: process.execPath, pre: [claudePath] } : { cmd: claudePath, pre: [] };
}

const fwd = (p) => p.replace(/\\/g, '/');

// Characters a hook shell would expand or end the quotes at, even inside "...":
// $ and ` (bash, Git Bash), % (cmd.exe), " and line breaks (both).
const SHELL_UNSAFE = /["`$%\r\n]/;

/**
 * BUG-15: a path put into a hook command, double-quoted. Throws (instead of
 * writing a command the shell would rewrite) when the path holds a character
 * that is not safe inside double quotes in bash or cmd.exe.
 */
export function quotePath(p) {
  const f = fwd(p);
  if (SHELL_UNSAFE.test(f)) {
    throw new Error(
      `This path has a character ($ % \` " or a line break) that the hook shell would expand: ${JSON.stringify(f)}. ` +
        'Clone the repo to a plain folder such as C:\\src\\agent-office and run again.',
    );
  }
  return `"${f}"`;
}

/** Hook block for the spawned runs: command hooks (log file) + http hooks (local server, run id header). */
export function hookSettings(port, logPath, script = SCRIPT) {
  const command = `node ${quotePath(script)} --hook-log ${quotePath(logPath)}`;
  const cmd = { type: 'command', command, async: true };
  const http = { type: 'http', url: `http://127.0.0.1:${port}/hook`, timeout: 10,
    headers: { 'X-Agent-Office-Run': '$AGENT_OFFICE_RUN_ID' }, allowedEnvVars: ['AGENT_OFFICE_RUN_ID'] };
  return { hooks: {
    SessionStart: [{ hooks: [cmd] }],
    UserPromptSubmit: [{ hooks: [cmd, http] }],
    Stop: [{ hooks: [cmd, http] }],
  } };
}

const cut = (s) => (typeof s === 'string' ? (s.length > EXCERPT ? s.slice(0, EXCERPT - 1) + '…' : s) : undefined);

/** Compact, non-sensitive record of one stream-json message (null = not worth recording). */
export function summarize(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const { type, subtype } = msg;
  if (type === 'system' && subtype === 'init') {
    return { type, subtype, hasSessionId: typeof msg.session_id === 'string', apiKeySource: msg.apiKeySource ?? null,
      permissionMode: msg.permissionMode ?? null };
  }
  if (type === 'result') return { type, subtype, isError: msg.is_error ?? null, excerpt: cut(msg.result) ?? null };
  if (type === 'control_response') return { type, subtype: msg.response?.subtype ?? null };
  if (type === 'assistant' || type === 'user' || type === 'stream_event') return null; // counted, not stored
  return { type, subtype: subtype ?? null };
}

// ---- process helpers ----

function killTree(child) {
  return new Promise((done) => {
    if (child.exitCode !== null || child.pid === undefined) return done('already exited');
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false }, (err) => done(err ? `taskkill error ${err.code}` : 'taskkill /T /F'));
    } else {
      child.kill('SIGKILL');
      done('SIGKILL');
    }
  });
}

/** Spawn one headless run and collect what it prints. */
export function startRun(claude, args, env) {
  const t0 = Date.now();
  const { cmd, pre } = spawnTarget(claude);
  const child = spawn(cmd, [...pre, ...args], { shell: false, env, cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const run = { child, t0, messages: [], counts: {}, sessionIds: new Set(), stderrBytes: 0, stderrHead: '', listeners: [], spawnError: null };
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const text = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!text) continue;
      let msg;
      try { msg = JSON.parse(text); } catch { run.counts.nonJson = (run.counts.nonJson ?? 0) + 1; continue; }
      const key = msg.subtype ? `${msg.type}/${msg.subtype}` : String(msg.type);
      run.counts[key] = (run.counts[key] ?? 0) + 1;
      if (typeof msg.session_id === 'string') run.sessionIds.add(msg.session_id);
      const s = summarize(msg);
      if (s) run.messages.push({ atMs: Date.now() - t0, ...s });
      for (const l of [...run.listeners]) l(msg);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    run.stderrBytes += c.length;
    if (run.stderrHead.length < STDERR_HEAD) run.stderrHead = (run.stderrHead + c).slice(0, STDERR_HEAD);
  });
  child.stdin.on('error', () => {}); // EPIPE after exit is expected in the stop tests
  run.exited = new Promise((done) => {
    child.on('error', (err) => { run.spawnError = err.code ?? String(err); done({ code: null, signal: null, atMs: Date.now() - t0 }); });
    child.on('exit', (code, signal) => done({ code, signal, atMs: Date.now() - t0 }));
  });
  run.write = (line) => { if (child.stdin.writable) child.stdin.write(line); };
  run.waitFor = (pred, ms) => new Promise((done) => {
    const timer = setTimeout(() => { off(); done(null); }, ms);
    const off = () => { run.listeners = run.listeners.filter((l) => l !== on); clearTimeout(timer); };
    const on = (m) => { if (pred(m)) { off(); done(m); } };
    run.listeners.push(on);
    run.exited.then(() => { off(); done(null); });
  });
  run.cap = setTimeout(() => { void killTree(child); }, RUN_CAP_MS);
  return run;
}

async function finish(run, extra = {}) {
  const exit = await run.exited;
  clearTimeout(run.cap);
  const id = [...run.sessionIds][0];
  return { exit, spawnError: run.spawnError, sessionId: id ?? null, sameSessionIdThroughout: run.sessionIds.size <= 1,
    counts: run.counts, messages: run.messages, stderrBytes: run.stderrBytes, stderrHead: run.stderrHead, ...extra };
}

const isResult = (m) => m.type === 'result';
const isOutput = (m) => m.type === 'stream_event' || m.type === 'assistant';

// ---- steps ----

function which() {
  const [cmd, args] = process.platform === 'win32' ? ['where.exe', ['claude']] : ['which', ['-a', 'claude']];
  return new Promise((done) => execFile(cmd, args, { shell: false }, (_e, out) => done(String(out ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))));
}

function probe(path) {
  return new Promise((done) => {
    const { cmd, pre } = spawnTarget(path);
    try {
      execFile(cmd, [...pre, '--version'], { shell: false, timeout: 20_000, env: childEnv(process.env, 'probe') }, (err, out) =>
        done(err ? { ok: false, error: err.code ?? String(err.message).slice(0, 80) } : { ok: true, version: cut(String(out).trim()) }));
    } catch (err) {
      done({ ok: false, error: err.code ?? 'throw' }); // e.g. EINVAL: Node refuses .cmd without a shell
    }
  });
}

/** For a .cmd shim, look for the cli.js it wraps, so it can be run with node and shell:false. */
function shimTarget(cmdPath) {
  try {
    const m = /"%(?:dp0|~dp0)%\\?([^"]*?\.js)"/i.exec(readFileSync(cmdPath, 'utf8'));
    if (!m) return null;
    const p = join(dirname(cmdPath), m[1]);
    return existsSync(p) ? p : null;
  } catch { return null; }
}

async function stepResolve(override) {
  // An explicit --claude path is tested alone (the PATH lookup was already recorded by a plain run).
  const found = override ? [override] : await which();
  const candidates = [];
  for (const path of found) {
    const entry = { path, ext: (/\.[a-z0-9]+$/i.exec(path)?.[0] ?? '(none)').toLowerCase(), ...(await probe(path)) };
    if (entry.ext === '.cmd') {
      const js = shimTarget(path);
      entry.wraps = js;
      if (js) entry.wrapsProbe = await probe(js);
    }
    candidates.push(entry);
  }
  const pick = candidates.find((c) => c.ok && c.ext !== '.cmd' && c.ext !== '.bat')
    ?? candidates.find((c) => c.wrapsProbe?.ok);
  return { candidates, chosen: pick ? (pick.ok && pick.ext !== '.cmd' ? pick.path : pick.wraps) : null };
}

async function stepMessage(ctx) {
  const run = startRun(ctx.claude, claudeArgs(ctx.settings), childEnv(process.env, ctx.runId('message')));
  run.write(userLine(PROMPTS.count));
  run.write(userLine(PROMPTS.second)); // sent while turn 1 is still running
  let results = 0;
  const two = await run.waitFor((m) => isResult(m) && ++results >= 2, 90_000);
  run.child.stdin.end();
  return finish(run, { secondResultArrived: two !== null, secondSaysTwo: typeof two?.result === 'string' && two.result.includes('TWO') });
}

async function stepStop(ctx, method) {
  const run = startRun(ctx.claude, claudeArgs(ctx.settings, ['--include-partial-messages']), childEnv(process.env, ctx.runId(`stop-${method}`)));
  run.write(userLine(PROMPTS.story));
  const first = await run.waitFor(isOutput, 60_000);
  const stopAt = Date.now() - run.t0;
  const out = { method, outputSeenBeforeStop: first !== null, stopAtMs: stopAt };
  if (method === 'interrupt') {
    run.write(interruptLine('s3-int-1'));
    const res = await run.waitFor(isResult, STOP_WAIT_MS);
    out.resultAfterStopMs = res ? Date.now() - run.t0 - stopAt : null;
    out.resultSubtype = res?.subtype ?? null;
    out.aliveAfterResult = run.child.exitCode === null;
    if (out.aliveAfterResult) {
      run.write(userLine(PROMPTS.after));
      const after = await run.waitFor(isResult, 60_000);
      out.acceptsNextMessage = typeof after?.result === 'string' && after.result.includes('AFTER');
      run.child.stdin.end();
    }
  } else if (method === 'close-stdin') {
    run.child.stdin.end();
  } else {
    out.killedBy = await killTree(run.child);
  }
  let timer;
  const graceful = await Promise.race([run.exited, new Promise((r) => { timer = setTimeout(() => r(null), STOP_WAIT_MS * 6); })]);
  clearTimeout(timer);
  if (graceful === null) out.forcedAfterWait = await killTree(run.child);
  return finish(run, out);
}

async function stepResume(ctx, sessionId, label) {
  if (!sessionId) return { skipped: `no session id from ${label}` };
  const run = startRun(ctx.claude, claudeArgs(ctx.settings, ['--resume', sessionId]), childEnv(process.env, ctx.runId(`resume-${label}`)));
  run.write(userLine(PROMPTS.resume));
  const res = await run.waitFor(isResult, 90_000);
  run.child.stdin.end();
  return finish(run, { resumedFrom: label, gotResult: res !== null, sameSessionId: run.sessionIds.has(sessionId) });
}

/** Local server for the http hooks. Stores event name + run header only, never the body. */
function hookServer(seen) {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { if (body.length < 65_536) body += c; });
    req.on('end', () => {
      let event = null;
      try { event = JSON.parse(body).hook_event_name ?? null; } catch { /* not JSON */ }
      seen.push({ event, runHeader: req.headers['x-agent-office-run'] ?? null });
      res.writeHead(200).end();
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

/** --hook-log mode: invoked by Claude Code as a command hook. Logs the event name only. Always exit 0, no stdout. */
function hookMode(logPath) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(raw).hook_event_name ?? null;
      appendFileSync(logPath, JSON.stringify({ event, runIdEnv: process.env.AGENT_OFFICE_RUN_ID ?? null }) + '\n');
    } catch { /* never fail the hook */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

async function main(argv) {
  const hookLog = argv.indexOf('--hook-log');
  if (hookLog >= 0) return hookMode(argv[hookLog + 1] ?? '');
  const ci = argv.indexOf('--claude');
  const override = ci >= 0 ? argv[ci + 1] : undefined;
  const dir = process.env.AGENT_OFFICE_S3_DIR || join(ROOT, '.spike', 's3'); // override used by the tests
  mkdirSync(dir, { recursive: true });
  const base = `s3-${Date.now().toString(36)}`;
  const report = {
    spike: 'S3', at: new Date().toISOString(), platform: process.platform, node: process.version,
    parentEnvHas: Object.fromEntries(STRIPPED_ENV.map((k) => [k, Object.keys(process.env).some((e) => e.toUpperCase() === k)])),
    resolve: await stepResolve(override),
  };
  const claude = override ?? report.resolve.chosen;
  if (!argv.includes('--run') || !claude) {
    report.note = claude ? 'Resolve only. Re-run with --run for the full spike.' : 'No working claude executable found; see candidates.';
  } else {
    const seen = [];
    const server = await hookServer(seen);
    const logPath = join(dir, 'hook-cmd.log');
    writeFileSync(logPath, '');
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, JSON.stringify(hookSettings(server.address().port, logPath), null, 2));
    const ctx = { claude, settings, runId: (step) => `${base}-${step}` };
    report.runIdPrefix = base;
    report.message = await stepMessage(ctx);
    report.stopInterrupt = await stepStop(ctx, 'interrupt');
    report.stopCloseStdin = await stepStop(ctx, 'close-stdin');
    report.stopKill = await stepStop(ctx, 'kill');
    report.resumeAfterInterrupt = await stepResume(ctx, report.stopInterrupt.sessionId, 'interrupt');
    report.resumeAfterKill = await stepResume(ctx, report.stopKill.sessionId, 'kill');
    await new Promise((r) => setTimeout(r, 3000)); // let async command hooks finish
    server.close();
    report.httpHooks = seen;
    report.commandHooks = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  const text = JSON.stringify(report, null, 2);
  writeFileSync(join(dir, 'report.json'), text);
  process.stdout.write(`=== S3 REPORT START ===\n${text}\n=== S3 REPORT END ===\n`);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`spike-s3 failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
