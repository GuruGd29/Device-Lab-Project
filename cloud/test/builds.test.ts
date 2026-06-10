// Build library + install-job lifecycle against real Postgres.
import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import type { Config } from "../src/config.js";
import { EventBus } from "../src/lib/events.js";
import { BuildsService } from "../src/services/builds.js";
import { InstallService } from "../src/services/install.js";
import { describeDb, makeTestPool, truncateAll, seedTv } from "./helpers.js";

const config: Config = {
  port: 0, databaseUrl: "", natsUrl: null, runMigrations: false,
  agentSharedSecret: "x", jwtSecret: "x", leaseTtlSeconds: 120, hardSessionSeconds: 2400,
  reconcileIntervalSeconds: 10, heartbeatTimeoutSeconds: 30, calibrationTimeoutSeconds: 20,
  uploadsDir: join(tmpdir(), "devicelab-test-uploads"), maxUploadBytes: 1024,
  publicHttpUrl: "http://localhost:8080",
};

describeDb("Builds + Install lifecycle", () => {
  let pool: pg.Pool;
  let events: EventBus;
  let builds: BuildsService;
  let install: InstallService;

  beforeAll(async () => {
    pool = await makeTestPool();
    events = await EventBus.create(null);
    builds = new BuildsService(pool, config);
    install = new InstallService(pool, events);
  });
  afterAll(async () => {
    await events.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    await pool.query("TRUNCATE builds, install_jobs RESTART IDENTITY CASCADE");
    await seedTv(pool, { tvId: "tv-1", bind: true });
  });

  it("records a build and derives platform from the package kind", async () => {
    const b = await builds.record({
      build_id: "b1", filename: "app-release.wgt", package_kind: "wgt",
      size_bytes: 1234, storage_path: "/tmp/b1.wgt", app_id: "com.acme.app", uploaded_by: "u1",
    });
    expect(b.platform).toBe("tizen"); // wgt -> tizen
    expect(b.size_bytes).toBe(1234);
    expect(builds.downloadUrl("b1")).toBe("http://localhost:8080/builds/b1/download");
  });

  it("lists builds and filters by platform", async () => {
    await builds.record({ build_id: "b-apk", filename: "a.apk", package_kind: "apk", size_bytes: 1, storage_path: "/tmp/a", app_id: null, uploaded_by: "u1" });
    await builds.record({ build_id: "b-wgt", filename: "a.wgt", package_kind: "wgt", size_bytes: 1, storage_path: "/tmp/b", app_id: null, uploaded_by: "u1" });
    expect((await builds.list()).length).toBe(2);
    const apks = await builds.list("androidtv");
    expect(apks.map((b) => b.build_id)).toEqual(["b-apk"]);
  });

  it("install job: queued -> downloading -> installing -> installed, latest reflects state", async () => {
    await builds.record({ build_id: "b1", filename: "a.wgt", package_kind: "wgt", size_bytes: 1, storage_path: "/tmp/b1", app_id: null, uploaded_by: "u1" });
    const events_seen: string[] = [];
    events.on("install.update", (e) => events_seen.push(e.job.status));

    const job = await install.create("tv-1", "b1", "u1");
    expect(job.status).toBe("queued");

    await install.applyProgress(job.job_id, "downloading", 0.3);
    await install.applyProgress(job.job_id, "installing", 0.7, "running tizen install");
    await install.applyProgress(job.job_id, "installed", 1.0);

    const latest = await install.latestForTv("tv-1");
    expect(latest?.status).toBe("installed");
    expect(latest?.progress).toBe(1);
    // Each transition pushed a live update (create + 3 progress = 4).
    expect(events_seen).toEqual(["queued", "downloading", "installing", "installed"]);
  });

  it("deleting a build cascades its install jobs", async () => {
    await builds.record({ build_id: "b1", filename: "a.wgt", package_kind: "wgt", size_bytes: 1, storage_path: "/tmp/b1", app_id: null, uploaded_by: "u1" });
    const job = await install.create("tv-1", "b1", "u1");
    expect(await builds.delete("b1")).toBe(true);
    expect(await install.get(job.job_id)).toBeNull(); // ON DELETE CASCADE
  });
});
