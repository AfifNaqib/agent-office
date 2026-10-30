// The emit pipeline: stdin text -> OfficeEvent -> POST. Dependencies are injected
// so tests can drive it; the built file is tested end to end by spawning it.
import { MAX_EVENT_BYTES, fingerprint, normalize } from '@agent-office/core';
import { resolveDestination, type Env } from './destination.js';
import { shouldYieldToRepoCopy } from './precedence.js';

/**
 * A2.3 (B-05): these hooks have no tool_use_id, so two identical asks would hash
 * to one id and the second would be deduped. Their id also covers a per-invocation
 * nonce. Every other hook keeps id = fingerprint(source, stdin). The nonce is
 * never sent or stored; only the resulting id travels.
 */
export const NONCE_HOOKS: ReadonlySet<string> = new Set(['PermissionRequest', 'Notification']);

/** FR-003: the send gives up after 3 s. */
export const SEND_TIMEOUT_MS = 3_000;
/**
 * Plan A3.1 (PROVISIONAL): the first cloud request of a session can reach the
 * relay before the proxy adds the network-secret header (spike S1), so a 401 from
 * /ingest is retried once after this pause. Cloud only: a PC 401 means a wrong
 * local token, and a retry would not fix it.
 */
export const RETRY_DELAY_MS = 1_500;
/** The retry is skipped when less than this is left before the deadline. */
export const MIN_RETRY_SEND_MS = 500;
const UNAUTHORIZED = 401;

export interface EmitDeps {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly readToken: (file: string) => string | undefined;
  /** B-07: `port` from <data dir>/config.json (same file the bridge reads). Optional: tests that do not care leave it out. */
  readonly readConfigPort?: (file: string) => number | undefined;
  /** A2.3: per-invocation random string (32 hex chars). Only used for the kinds in NONCE_HOOKS. */
  readonly nonce: () => string;
  /** A3.1: time (same clock as `now`) by which every send must be over. Default: no limit beyond SEND_TIMEOUT_MS per send. */
  readonly deadline?: number;
  /** A3.1: the pause before the 401 retry. Injected so unit tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type EmitResult =
  | 'sent'
  | 'send-failed'
  | 'yielded-to-repo-copy'
  | 'malformed-input'
  | 'ignored-event'
  | 'no-destination'
  | 'too-large';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Never throws: every failure is a result value. Never writes anywhere but the one POST. */
export async function emit(env: Env, stdin: string, selfPath: string, deps: EmitDeps): Promise<EmitResult> {
  try {
    if (shouldYieldToRepoCopy(env, selfPath)) return 'yielded-to-repo-copy';
    const payload = parseJson(stdin);
    if (typeof payload !== 'object' || payload === null) return 'malformed-input';

    const dest = resolveDestination(env, deps.readToken, deps.readConfigPort);
    if (!dest) return 'no-destination';

    const hookName = (payload as Record<string, unknown>).hook_event_name;
    const withNonce = typeof hookName === 'string' && NONCE_HOOKS.has(hookName);
    const id = await fingerprint(dest.source, withNonce ? `${stdin}\n${deps.nonce()}` : stdin);
    const event = normalize(payload, {
      id,
      emittedAt: deps.now(),
      source: dest.source,
      remoteSessionId: env.CLAUDE_CODE_REMOTE_SESSION_ID,
      runId: env.AGENT_OFFICE_RUN_ID,
    });
    if (!event) return 'ignored-event';

    const body = JSON.stringify(event);
    if (new TextEncoder().encode(body).length > MAX_EVENT_BYTES) return 'too-large';

    // Never an Authorization header: in the cloud the proxy adds it (A3.1).
    const post = async (timeoutMs: number): Promise<number> => {
      const res = await deps.fetch(dest.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...dest.headers },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel();
      return res.status;
    };
    const deadline = deps.deadline ?? Infinity;
    const status = await post(Math.max(1, Math.min(SEND_TIMEOUT_MS, deadline - deps.now())));
    if (status !== UNAUTHORIZED || dest.source !== 'cloud') return 'sent';
    if (deadline - deps.now() < RETRY_DELAY_MS + MIN_RETRY_SEND_MS) return 'sent';
    await (deps.sleep ?? defaultSleep)(RETRY_DELAY_MS);
    await post(Math.max(1, Math.min(SEND_TIMEOUT_MS, deadline - deps.now())));
    return 'sent';
  } catch {
    return 'send-failed';
  }
}
