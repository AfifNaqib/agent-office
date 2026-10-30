// The SQL surface the hub needs, so HubCore runs on the Durable Object's SQLite
// (ctx.storage.sql) and, in tests, on node:sqlite. Bound parameters only (plan §11).
export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqlStore {
  /** One statement. Returns the rows (SELECT or RETURNING), else []. */
  exec<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]): T[];
  /** Runs fn atomically (DO: storage.transactionSync). */
  transaction<T>(fn: () => T): T;
}

/**
 * Ordered schema steps; a database at version n runs steps n.. once. V1-01 creates
 * sessions + events (plan §7). V1-03 adds hub_meta (the persistent `boot` id). V2 appends runs, permission_requests, command_audit
 * as new steps; never edit a shipped step.
 */
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE sessions (
      session_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      remote_session_id TEXT,
      run_id TEXT,
      repo TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_event_at INTEGER NOT NULL,
      ended_at INTEGER
    )`,
    'CREATE INDEX sessions_last_event_at ON sessions (last_event_at)',
    `CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_key TEXT NOT NULL REFERENCES sessions (session_key),
      emitted_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      agent_type TEXT,
      payload_json TEXT NOT NULL
    )`,
    'CREATE INDEX events_session_seq ON events (session_key, seq)',
    'CREATE INDEX events_received_at ON events (received_at)',
    `CREATE TABLE rate_limits (
      bucket TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL
    )`,
  ],
  // V1-03: small key/value table; holds the hub's `boot` id (see HubCore.boot).
  ['CREATE TABLE hub_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'],
];

const META = 'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)';

/** Brings the schema up to date. Idempotent; returns the version reached. */
export function migrate(sql: SqlStore): number {
  return sql.transaction(() => {
    sql.exec(META);
    const row = sql.exec<{ value: number }>("SELECT value FROM schema_meta WHERE key = 'version'")[0];
    let version = row?.value ?? 0;
    for (; version < MIGRATIONS.length; version += 1) {
      for (const stmt of MIGRATIONS[version] ?? []) sql.exec(stmt);
    }
    sql.exec(
      "INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      version,
    );
    return version;
  });
}
