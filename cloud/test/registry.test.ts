// Registry + binding + state-machine integration through real Postgres — exercises the
// §9 reconcile table transitions end to end (no_camera -> free -> unhealthy -> offline).
import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import type pg from "pg";
import type { Config } from "../src/config.js";
import { EventBus } from "../src/lib/events.js";
import { RegistryService } from "../src/services/registry.js";
import { BindingService } from "../src/services/binding.js";
import { describeDb, makeTestPool, truncateAll } from "./helpers.js";

const config: Config = {
  port: 0,
  databaseUrl: "",
  natsUrl: null,
  runMigrations: false,
  agentSharedSecret: "x",
  jwtSecret: "x",
  leaseTtlSeconds: 120,
  hardSessionSeconds: 2400,
  reconcileIntervalSeconds: 10,
  heartbeatTimeoutSeconds: 30,
  calibrationTimeoutSeconds: 20,
};

describeDb("Registry + Binding (state-machine transitions)", () => {
  let pool: pg.Pool;
  let events: EventBus;
  let registry: RegistryService;
  let bindings: BindingService;

  beforeAll(async () => {
    pool = await makeTestPool();
    events = await EventBus.create(null); // in-process bus, no NATS
    registry = new RegistryService(pool, config, events);
    bindings = new BindingService(pool, registry);
  });
  afterAll(async () => {
    await events.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    await registry.registerDevices(
      "agent-1",
      [
        {
          tv_id: "tv-1",
          platform: "tizen",
          control_protocol: "samsung_ws",
          status: "free",
        },
      ],
      [{ camera_id: "cam-1", status: "online", sfu_publish_track: "track-1" }],
    );
    // Agent itself must exist with an sfu url for stream resolution paths.
    await registry.upsertAgent({ agent_id: "agent-1", sfu_signaling_url: "ws://lab:7000/sfu" });
  });

  it("a TV with no binding is no_camera (controllable but blind) and not testable", async () => {
    const tv = await registry.getTvView("tv-1", "u1");
    expect(tv?.status).toBe("no_camera");
    expect(tv?.binding).toBeNull();
    expect(tv?.testable).toBe(false);
  });

  it("binding a healthy camera flips it to free + testable", async () => {
    const r = await bindings.createManual("tv-1", "cam-1", "u1");
    expect(r.ok).toBe(true);
    const tv = await registry.getTvView("tv-1", "u1");
    expect(tv?.status).toBe("free");
    expect(tv?.binding?.camera_id).toBe("cam-1");
    expect(tv?.testable).toBe(true);
  });

  it("binding a non-existent camera fails cleanly", async () => {
    const r = await bindings.createManual("tv-1", "ghost-cam", "u1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_such_camera");
  });

  it("bound camera going unhealthy -> TV unhealthy, NOT free (spec §9)", async () => {
    await bindings.createManual("tv-1", "cam-1", "u1");
    await registry.applyHeartbeat(
      "agent-1",
      [{ tv_id: "tv-1", status: "free" }],
      [{ camera_id: "cam-1", status: "unhealthy" }],
    );
    const tv = await registry.getTvView("tv-1", "u1");
    expect(tv?.status).toBe("unhealthy");
    expect(tv?.testable).toBe(false);
  });

  it("camera recovering brings the TV back to free", async () => {
    await bindings.createManual("tv-1", "cam-1", "u1");
    await registry.applyHeartbeat("agent-1", [], [{ camera_id: "cam-1", status: "unhealthy" }]);
    await registry.applyHeartbeat("agent-1", [], [{ camera_id: "cam-1", status: "online" }]);
    const tv = await registry.getTvView("tv-1", "u1");
    expect(tv?.status).toBe("free");
  });

  it("agent disconnect marks its devices offline", async () => {
    await bindings.createManual("tv-1", "cam-1", "u1");
    await registry.markAgentDevicesOffline("agent-1");
    const tv = await registry.getTvView("tv-1", "u1");
    expect(tv?.status).toBe("offline");
    const cams = await registry.listCameras();
    expect(cams[0]?.status).toBe("offline");
  });

  it("unassign severs the link -> back to no_camera", async () => {
    await bindings.createManual("tv-1", "cam-1", "u1");
    expect(await bindings.unassign("tv-1")).toBe(true);
    const tv = await registry.getTvView("tv-1", "u1");
    expect(tv?.status).toBe("no_camera");
    expect(tv?.binding).toBeNull();
  });

  it("registering devices that reference a slot auto-creates the slot (FK regression)", async () => {
    // The agent reports slot_id; the cloud owns the slots table. Devices must not FK-fail.
    await registry.registerDevices(
      "agent-2",
      [
        {
          tv_id: "tv-slotted",
          platform: "webos",
          control_protocol: "lg_ssap",
          status: "free",
          slot_id: "rack-B/pos-09",
          rack_position: "rack-B/pos-09",
        },
      ],
      [{ camera_id: "cam-slotted", status: "online", slot_id: "rack-B/pos-09", sfu_publish_track: "t9" }],
    );
    const slot = await pool.query("SELECT rack_position FROM slots WHERE slot_id = $1", [
      "rack-B/pos-09",
    ]);
    expect(slot.rowCount).toBe(1);
    // And the device rows landed, so a binding across them works.
    const r = await bindings.createManual("tv-slotted", "cam-slotted", "u1");
    expect(r.ok).toBe(true);
    const tv = await registry.getTvView("tv-slotted", "u1");
    expect(tv?.status).toBe("free");
  });

  it("repointing a camera to another TV moves the binding (1:1)", async () => {
    await registry.registerDevices(
      "agent-1",
      [{ tv_id: "tv-2", platform: "webos", control_protocol: "lg_ssap", status: "free" }],
      [],
    );
    await bindings.createManual("tv-1", "cam-1", "u1");
    await bindings.createManual("tv-2", "cam-1", "u1"); // repoint same camera
    const tv1 = await registry.getTvView("tv-1", "u1");
    const tv2 = await registry.getTvView("tv-2", "u1");
    expect(tv1?.binding).toBeNull(); // camera moved away
    expect(tv2?.binding?.camera_id).toBe("cam-1");
  });
});
