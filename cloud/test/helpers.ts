// Test harness. Reservation/binding tests need REAL Postgres semantics (atomic ON CONFLICT,
// interval math) — an in-memory shim can't prove the lock is race-free. Point them at a
// throwaway DB via TEST_DATABASE_URL (defaults to the docker-compose db). If unreachable,
// `describeDb` skips the suite with a clear message rather than failing CI on a missing dep.
import pg from "pg";
import { describe, inject } from "vitest";
import { runMigrations } from "../src/migrate.js";

const { Pool } = pg;

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://devicelab:devicelab@localhost:5432/devicelab";

export async function makeTestPool(): Promise<pg.Pool> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 16 });
  await runMigrations(pool);
  return pool;
}

/** describe() that auto-skips when no Postgres was reachable at globalSetup time. */
export function describeDb(name: string, fn: () => void): void {
  const reachable = inject("dbReachable");
  describe.skipIf(!reachable)(name, fn);
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    "TRUNCATE reservations, bindings, cameras, tvs, slots, agents RESTART IDENTITY CASCADE",
  );
}

export interface SeedOpts {
  tvId?: string;
  cameraId?: string | null; // null = no camera at all
  agentId?: string;
  tvStatus?: string;
  cameraStatus?: "online" | "offline" | "unhealthy";
  bind?: boolean; // create a binding tv<->camera
  sfuTrack?: string;
}

/** Insert a slot + (optional) camera + tv, optionally bound. Returns ids. */
export async function seedTv(
  pool: pg.Pool,
  opts: SeedOpts = {},
): Promise<{ tvId: string; cameraId: string | null; agentId: string }> {
  const agentId = opts.agentId ?? "agent-1";
  const tvId = opts.tvId ?? "tv-1";
  const cameraId = opts.cameraId === undefined ? "cam-1" : opts.cameraId;
  const slotId = `slot-${tvId}`;

  await pool.query(
    "INSERT INTO agents (agent_id, sfu_signaling_url, connected) VALUES ($1,$2,true) ON CONFLICT (agent_id) DO NOTHING",
    [agentId, "ws://localhost:7000/sfu"],
  );
  await pool.query(
    "INSERT INTO slots (slot_id, rack_position, host_agent_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [slotId, "rack-A/pos-1", agentId],
  );
  if (cameraId) {
    await pool.query(
      `INSERT INTO cameras (camera_id, slot_id, host_agent_id, sfu_publish_track, status, last_heartbeat_at)
       VALUES ($1,$2,$3,$4,$5, now())`,
      [cameraId, slotId, agentId, opts.sfuTrack ?? "track-1", opts.cameraStatus ?? "online"],
    );
  }
  await pool.query(
    `INSERT INTO tvs (tv_id, platform, slot_id, rack_position, control_protocol, host_agent_id, status, agent_status, last_heartbeat_at)
     VALUES ($1,'tizen',$2,'rack-A/pos-1','samsung_ws',$3,$4,'free', now())`,
    [tvId, slotId, agentId, opts.tvStatus ?? "free"],
  );
  if (opts.bind && cameraId) {
    await pool.query(
      `INSERT INTO bindings (tv_id, camera_id, method, confidence, last_verified_at)
       VALUES ($1,$2,'qr_handshake',1.0, now())`,
      [tvId, cameraId],
    );
  }
  return { tvId, cameraId, agentId };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
