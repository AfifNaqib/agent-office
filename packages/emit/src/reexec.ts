// Plan A3.1: in a cloud session emit must send through the egress proxy, because
// only proxied traffic gets the network secret's Authorization header (spike S1).
// Node `fetch` ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1, so the first run
// re-runs this same script ONCE with that flag and a loop marker, hands it the
// same stdin bytes, and waits. The parent never sends anything itself.
import { spawn } from 'node:child_process';
import { cloudDestination, isCloud, type Env } from './destination.js';

/** Node's switch that makes `fetch` honour HTTPS_PROXY / HTTP_PROXY / NO_PROXY. */
export const PROXY_FLAG = 'NODE_USE_ENV_PROXY';
/** Set in the child's environment; any value (even empty) stops a further re-exec. */
export const REEXEC_MARKER = 'AGENT_OFFICE_EMIT_REEXEC';

function present(v: string | undefined): boolean {
  return v !== undefined && v.trim() !== '';
}

/** The proxy Node will use: lowercase first, even when it is empty (same order as Node). */
function httpsProxy(env: Env): string | undefined {
  return env.https_proxy ?? env.HTTPS_PROXY;
}

/**
 * True only for: cloud AND a usable relay URL AND a non-blank https proxy (Node's order)
 * AND NODE_USE_ENV_PROXY is not "1" AND the marker is not set. The PC path never
 * re-runs (no Node version check there).
 */
export function shouldReexec(env: Env): boolean {
  return (
    isCloud(env) &&
    cloudDestination(env) !== null &&
    present(httpsProxy(env)) &&
    env[PROXY_FLAG] !== '1' &&
    env[REEXEC_MARKER] === undefined
  );
}

/** The child's environment: everything the parent has, plus the flag and the marker. */
export function childEnv(env: Env): Record<string, string | undefined> {
  return { ...env, [PROXY_FLAG]: '1', [REEXEC_MARKER]: '1' };
}

export type ReexecResult = 'exited' | 'killed' | 'spawn-failed';

export interface ReexecOptions {
  readonly execPath: string;
  readonly script: string;
  readonly env: Env;
  readonly stdin: Buffer;
  /** The child is killed after this long, so the parent stays inside its 6 s watchdog. */
  readonly timeoutMs: number;
}

/**
 * Runs `execPath script` (no shell) with childEnv, writes stdin, waits for it to
 * exit or kills it at timeoutMs. The child's stdout and stderr are discarded, so
 * nothing it prints can reach Claude Code. Never throws.
 */
export function reexec(opts: ReexecOptions): Promise<ReexecResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.execPath, [opts.script], {
        env: childEnv(opts.env),
        stdio: ['pipe', 'ignore', 'ignore'],
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve('spawn-failed');
      return;
    }
    const timer = setTimeout(
      () => {
        child.kill('SIGKILL');
        resolve('killed');
      },
      Math.max(0, opts.timeoutMs),
    );
    child.on('error', () => {
      clearTimeout(timer);
      resolve('spawn-failed');
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve('exited');
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.stdin);
  });
}
