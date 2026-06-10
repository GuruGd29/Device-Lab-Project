import pg from "pg";

const { Pool } = pg;
export type DbPool = pg.Pool;

// `node-pg` returns TIMESTAMPTZ as JS Date by default; we serialize to ISO strings at the
// API edge. BIGINT/NUMERIC parsing is irrelevant here (no such columns), so defaults are fine.

export function createPool(databaseUrl: string): DbPool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (err) => {
    // Idle client errors shouldn't crash the process.
    // eslint-disable-next-line no-console
    console.error("[db] idle client error", err);
  });
  return pool;
}

/** ISO string or null for a TIMESTAMPTZ column value coming back from pg. */
export function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
