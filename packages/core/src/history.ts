// History API helpers shared by the PC bridge and the relay (plan §10), so both
// answer `?after=&limit=` and session keys the same way and the web client can talk
// to either one with the same code.
import { SessionIdSchema } from './schema.js';

/** Events per history page when the client sends no limit. */
export const DEFAULT_PAGE = 1000;
/** Largest page a client can ask for; bigger limits are clamped to this. */
export const MAX_PAGE = 5000;

export interface Paging {
  readonly after: number;
  readonly limit: number;
}

/**
 * `after` (seq cursor, default 0) and `limit` (default DEFAULT_PAGE, clamped to
 * 1..MAX_PAGE) from the query string. Undefined when either is not a plain
 * non-negative integer (callers answer 400).
 */
export function parsePaging(after: string | undefined, limit: string | undefined): Paging | undefined {
  if (after !== undefined && !/^\d{1,15}$/.test(after)) return undefined;
  if (limit !== undefined && !/^\d{1,5}$/.test(limit)) return undefined;
  const l = limit === undefined ? DEFAULT_PAGE : Number(limit);
  return { after: after === undefined ? 0 : Number(after), limit: Math.min(Math.max(l, 1), MAX_PAGE) };
}

const KEY_RE = /^(local|cloud):(.{1,200})$/;

/** A well-formed `source:sessionId` session key (see sessionKey). */
export function isSessionKey(key: string): boolean {
  const m = KEY_RE.exec(key);
  return m?.[2] !== undefined && SessionIdSchema.safeParse(m[2]).success;
}
