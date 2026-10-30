// Hook entry point (FR-001 to FR-004). Reads one hook payload from stdin, sends
// one scrubbed OfficeEvent, and ALWAYS exits 0 with nothing on stdout (Claude Code
// reads stdout). Runs as an async hook, so it never slows Claude down.
// In a cloud session behind the egress proxy it re-runs itself once with
// NODE_USE_ENV_PROXY=1 and lets that child send (plan A3.1, reexec.ts).
import { fileURLToPath } from 'node:url';
import { reexec, shouldReexec } from './reexec.js';
import { emit } from './run.js';
import { readConfigPort } from './portfile.js';
import { readToken } from './token.js';

/** Hook payloads can hold whole file contents; anything bigger is not parsed. */
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const STDIN_TIMEOUT_MS = 2_000;
/** stdin read + 3 s send + slack. Nothing may keep the process alive past this. */
const WATCHDOG_MS = 6_000;
/** Sends (and a re-exec child) must be over this long before the watchdog fires. */
const DEADLINE_MARGIN_MS = 250;

/** The stdin bytes, or undefined when the read was cut off, failed or too big. */
function readStdin(): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A cut-off or oversized read is malformed input, not a partial event.
      resolve(ok && size <= MAX_STDIN_BYTES ? Buffer.concat(chunks) : undefined);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_STDIN_BYTES) chunks.push(c);
    });
    process.stdin.on('end', () => {
      finish(true);
    });
    process.stdin.on('error', () => {
      finish(false);
    });
  });
}

/** A2.3: 16 random bytes as hex; mixed into the id of PermissionRequest and Notification only. Never sent. */
function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function quit(): never {
  process.exit(0);
}

async function main(): Promise<void> {
  process.on('uncaughtException', quit);
  process.on('unhandledRejection', quit);
  const deadline = Date.now() + WATCHDOG_MS - DEADLINE_MARGIN_MS;
  setTimeout(quit, WATCHDOG_MS).unref();
  const stdin = await readStdin();
  const self = fileURLToPath(import.meta.url);
  if (stdin !== undefined && stdin.length > 0 && shouldReexec(process.env)) {
    // The child gets the same bytes and sends; this process sends nothing.
    await reexec({ execPath: process.execPath, script: self, env: process.env, stdin, timeoutMs: deadline - Date.now() });
    quit();
  }
  const text = stdin?.toString('utf8') ?? '';
  await emit(process.env, text, self, { fetch, now: () => Date.now(), readToken, readConfigPort, nonce, deadline });
  quit();
}

void main();
