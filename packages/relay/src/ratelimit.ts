// Per-minute counters kept in the DO's SQLite (plan §11 "Rate limits"), so they
// survive the object being evicted. Fixed one-minute windows.
import type { SqlStore } from './sql.js';

export const WINDOW_MS = 60_000;

/** Plan §11: ingest 600/min, bridge events 1200/min (V1-04). Commands (30) arrive with V2-01. */
export const LIMITS = { ingest: 600, bridge: 1200 } as const;
export type Bucket = keyof typeof LIMITS;

export type RateResult = { ok: true } | { ok: false; retryAfterSec: number };

/** Counts one hit; refuses once the bucket's limit for the current minute is used up. */
export function hit(sql: SqlStore, bucket: Bucket, now: number): RateResult {
  const limit = LIMITS[bucket];
  const windowStart = now - (now % WINDOW_MS);
  const row = sql.exec<{ count: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (bucket) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
    bucket,
    windowStart,
  )[0];
  if ((row?.count ?? 1) <= limit) return { ok: true };
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)) };
}
