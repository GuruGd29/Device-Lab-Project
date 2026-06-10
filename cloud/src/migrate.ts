// Migration runner. Applies cloud/migrations/*.sql in filename order, tracking applied
// files in schema_migrations. Safe to re-run. Invoked by `npm run migrate`, by the test
// harness, and on boot when RUN_MIGRATIONS=1.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type DbPool } from "./db.js";
import { loadConfig } from "./config.js";
import { log } from "./lib/log.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function runMigrations(pool: DbPool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [file],
    );
    if (rowCount && rowCount > 0) continue;
    const sql = await readFile(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      applied.push(file);
      log.info("migration applied", { file });
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${String(err)}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

// Run directly: `tsx src/migrate.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  runMigrations(pool)
    .then((applied) => {
      log.info("migrations complete", { applied: applied.length });
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      log.error("migration failed", { err: String(err) });
      process.exit(1);
    });
}
