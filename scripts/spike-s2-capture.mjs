#!/usr/bin/env node
// Spike S2: capture-only hook. Writes the raw hook stdin plus a little context
// to a local file so we can build real fixtures. It never sends anything anywhere.
//
// Configured by hooks-config/spike-s2-capture.settings.json (see docs/spikes/S2.md).
//
// Output: <dir>/<capturedAtMs>-<pid>-<HookEvent>.json, where <dir> is
//   $AGENT_OFFICE_CAPTURE_DIR, or <project>/.spike/s2/<platform> (gitignored).
//
// The capture file holds the RAW payload (prompts, file contents, commands).
// It must never be committed. Use scripts/spike-s2-export.mjs to turn captures
// into scrubbed fixtures.
//
// Rules: always exit 0, never write to stdout (stdout is read by Claude Code).

import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';

// Time from Node process start to the first line of this script. A lower bound
// for hook spawn cost (it excludes the shell Claude Code starts in shell form).
const bootMs = Math.round(performance.now());
const capturedAtMs = Date.now();

// Env vars whose PRESENCE we record. Values are never written, except a short,
// non-secret shape hint for the remote session id (e.g. "cse_").
const ENV_PRESENCE = [
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_EFFORT',
  'AGENT_OFFICE_RUN_ID',
  'AGENT_OFFICE_RELAY_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

const STDIN_TIMEOUT_MS = 5000;
const MAX_STDIN_BYTES = 2 * 1024 * 1024;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= MAX_STDIN_BYTES) chunks.push(c);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const raw = await readStdin();
  let hookEvent = 'unparsed';
  let parsedOk = false;
  try {
    const obj = JSON.parse(raw);
    parsedOk = true;
    if (obj && typeof obj.hook_event_name === 'string') {
      hookEvent = obj.hook_event_name.replace(/[^A-Za-z0-9]/g, '') || 'unnamed';
    }
  } catch {
    // keep raw text; parsedOk stays false
  }

  const env = Object.fromEntries(ENV_PRESENCE.map((k) => [k, Boolean(process.env[k])]));
  const remote = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  const projectDir = process.env.CLAUDE_PROJECT_DIR;

  const record = {
    capture: {
      version: 1,
      provenance: 'OBSERVED raw capture - NOT scrubbed - never commit this file',
      capturedAtMs,
      bootMs,
      form: argValue('--form') ?? 'unknown',
      platform: platform(),
      arch: arch(),
      node: process.version,
      env,
      remoteSessionIdShape: remote ? remote.slice(0, 4) : null,
      projectDirBasename: projectDir ? basename(projectDir.replace(/\\/g, '/')) : null,
      scriptBasename: basename(process.argv[1] ?? ''),
      stdinBytes: Buffer.byteLength(raw),
      parsedOk,
    },
    stdinRaw: raw,
  };

  const dir =
    process.env.AGENT_OFFICE_CAPTURE_DIR ||
    join(projectDir || process.cwd(), '.spike', 's2', platform());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${capturedAtMs}-${process.pid}-${hookEvent}.json`), JSON.stringify(record, null, 2));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
