// Dev seed: a couple of users so you can log into the dashboard immediately.
//   operator / operator   (role: operator)
//   admin / admin         (role: admin — can force-release + recalibrate)
// Real devices come from the lab agent, not the seed.
import { createPool } from "./db.js";
import { loadConfig } from "./config.js";
import { hashPassword } from "./auth.js";
import { runMigrations } from "./migrate.js";
import { log } from "./lib/log.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);

  const users = [
    { id: "u-operator", username: "operator", name: "Operator", pw: "operator", role: "operator" },
    { id: "u-admin", username: "admin", name: "Admin", pw: "admin", role: "admin" },
  ];
  for (const u of users) {
    await pool.query(
      `INSERT INTO users (user_id, username, display_name, password_hash, role)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
      [u.id, u.username, u.name, hashPassword(u.pw), u.role],
    );
    log.info("seeded user", { username: u.username, role: u.role });
  }
  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error("seed failed", { err: String(err) });
    process.exit(1);
  });
