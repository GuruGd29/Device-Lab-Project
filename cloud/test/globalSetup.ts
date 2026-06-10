// Runs once before the suite (separate process). Probes Postgres and `provide()`s the
// result so test files can read it via inject('dbReachable') at collection time and
// describe.skipIf() the DB-backed suites when no database is available.
import pg from "pg";
import type { GlobalSetupContext } from "vitest/node";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://devicelab:devicelab@localhost:5432/devicelab";

export default async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 1500,
  });
  let reachable = false;
  try {
    await pool.query("SELECT 1");
    reachable = true;
    // eslint-disable-next-line no-console
    console.log(`[test] Postgres reachable at ${TEST_DATABASE_URL}`);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[test] Postgres NOT reachable at ${TEST_DATABASE_URL} — DB-backed suites skipped.\n` +
        "        Start it with:  docker compose up -d db",
    );
  } finally {
    await pool.end().catch(() => {});
  }
  provide("dbReachable", reachable);
}

declare module "vitest" {
  interface ProvidedContext {
    dbReachable: boolean;
  }
}
