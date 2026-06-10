// Central config from env. Defaults make `npm run dev` work against the docker-compose db.

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`env ${name} must be a number, got "${v}"`);
  return n;
}

export interface Config {
  port: number;
  databaseUrl: string;
  natsUrl: string | null;
  runMigrations: boolean;
  agentSharedSecret: string;
  jwtSecret: string;
  /** Short, continuously-renewed reservation lease (spec §7.2). */
  leaseTtlSeconds: number;
  /** Max session window, never renewed (the hard ceiling). */
  hardSessionSeconds: number;
  /** Reconcile loop cadence. */
  reconcileIntervalSeconds: number;
  /** Device considered offline if no heartbeat within this window. */
  heartbeatTimeoutSeconds: number;
  /** Calibration scan timeout (how long the agent searches feeds for the QR). */
  calibrationTimeoutSeconds: number;
  /** Directory where uploaded build artifacts are stored. */
  uploadsDir: string;
  /** Max build upload size in bytes. */
  maxUploadBytes: number;
  /** Public base URL the lab agent uses to download builds from the cloud. */
  publicHttpUrl: string;
}

export function loadConfig(): Config {
  return {
    port: num("PORT", 8080),
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgres://devicelab:devicelab@localhost:5432/devicelab",
    natsUrl: process.env.NATS_URL || null,
    runMigrations: process.env.RUN_MIGRATIONS === "1",
    agentSharedSecret: process.env.AGENT_SHARED_SECRET ?? "dev-agent-secret",
    jwtSecret: process.env.JWT_SECRET ?? "dev-jwt-secret",
    leaseTtlSeconds: num("LEASE_TTL_SECONDS", 120),
    hardSessionSeconds: num("HARD_SESSION_SECONDS", 2400),
    reconcileIntervalSeconds: num("RECONCILE_INTERVAL_SECONDS", 10),
    heartbeatTimeoutSeconds: num("HEARTBEAT_TIMEOUT_SECONDS", 30),
    calibrationTimeoutSeconds: num("CALIBRATION_TIMEOUT_SECONDS", 20),
    uploadsDir: process.env.UPLOADS_DIR ?? "./uploads",
    maxUploadBytes: num("MAX_UPLOAD_BYTES", 500 * 1024 * 1024), // 500 MB
    publicHttpUrl:
      process.env.PUBLIC_HTTP_URL ?? `http://localhost:${num("PORT", 8080)}`,
  };
}
