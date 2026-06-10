// Registry — the source of truth read/write layer. Owns the tvs/cameras/slots/agents
// tables, folds agent reports into effective TV status via the state machine, assembles the
// denormalized TvView the dashboard renders, and emits change events for live push.
import type {
  Camera,
  CameraStatus,
  ControlProtocol,
  Platform,
  ReportedCamera,
  ReportedTv,
  TvStatus,
  TvView,
} from "@device-lab/contracts";
import { PLATFORM_TO_PROTOCOL } from "@device-lab/contracts";
import type { DbPool } from "../db.js";
import { iso } from "../db.js";
import type { Config } from "../config.js";
import type { EventBus } from "../lib/events.js";
import { computeTvStatus } from "./stateMachine.js";

function ms(d: Date | null): number | null {
  return d ? d.getTime() : null;
}

interface TvViewRow {
  tv_id: string;
  platform: Platform;
  serial: string | null;
  firmware_version: string | null;
  slot_id: string | null;
  rack_position: string | null;
  net_ip: string | null;
  mac: string | null;
  vlan: string | null;
  control_protocol: ControlProtocol;
  control_secret_ref: string | null;
  host_agent_id: string;
  status: TvStatus;
  agent_status: TvStatus | null;
  last_heartbeat_at: Date | null;
  b_camera_id: string | null;
  b_method: "qr_handshake" | "manual_confirm" | null;
  b_confidence: number | null;
  b_verified: Date | null;
  cam_status: CameraStatus | null;
  cam_hb: Date | null;
  r_held_by: string | null;
  r_session: string | null;
  r_lock_exp: Date | null;
  r_hard_exp: Date | null;
}

const TV_VIEW_SELECT = `
  SELECT t.tv_id, t.platform, t.serial, t.firmware_version, t.slot_id, t.rack_position,
         t.net_ip, t.mac, t.vlan, t.control_protocol, t.control_secret_ref, t.host_agent_id,
         t.status, t.agent_status, t.last_heartbeat_at,
         b.camera_id AS b_camera_id, b.method AS b_method, b.confidence AS b_confidence,
         b.last_verified_at AS b_verified,
         c.status AS cam_status, c.last_heartbeat_at AS cam_hb,
         r.held_by AS r_held_by, r.session_id AS r_session,
         r.lock_expires_at AS r_lock_exp, r.hard_expires_at AS r_hard_exp
    FROM tvs t
    LEFT JOIN bindings b ON b.tv_id = t.tv_id
    LEFT JOIN cameras c ON c.camera_id = b.camera_id
    LEFT JOIN reservations r
           ON r.tv_id = t.tv_id AND r.lock_expires_at > now() AND r.hard_expires_at > now()
`;

export class RegistryService {
  constructor(
    private readonly pool: DbPool,
    private readonly config: Config,
    private readonly events: EventBus,
  ) {}

  // ── Agents ──────────────────────────────────────────────────────────────
  async upsertAgent(a: {
    agent_id: string;
    hostname?: string;
    sfu_signaling_url: string;
    version?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agents (agent_id, hostname, sfu_signaling_url, version, last_seen_at, connected)
       VALUES ($1,$2,$3,$4, now(), true)
       ON CONFLICT (agent_id) DO UPDATE
         SET hostname = EXCLUDED.hostname, sfu_signaling_url = EXCLUDED.sfu_signaling_url,
             version = EXCLUDED.version, last_seen_at = now(), connected = true`,
      [a.agent_id, a.hostname ?? null, a.sfu_signaling_url, a.version ?? null],
    );
  }

  async getAgentSfuUrl(agentId: string): Promise<string | null> {
    const res = await this.pool.query<{ sfu_signaling_url: string }>(
      "SELECT sfu_signaling_url FROM agents WHERE agent_id = $1",
      [agentId],
    );
    return res.rowCount ? res.rows[0]!.sfu_signaling_url : null;
  }

  async setAgentConnected(agentId: string, connected: boolean): Promise<void> {
    await this.pool.query(
      "UPDATE agents SET connected = $2, last_seen_at = now() WHERE agent_id = $1",
      [agentId, connected],
    );
  }

  // ── Device registration (full inventory snapshot from the agent) ──────────
  async registerDevices(
    agentId: string,
    tvs: ReportedTv[],
    cameras: ReportedCamera[],
  ): Promise<void> {
    // Slots are FK targets for cameras/tvs; the agent reports slot_id but the cloud owns the
    // slots table, so create any referenced slot before inserting devices that ride it.
    const hints = new Map<string, string | null>();
    for (const tv of tvs) if (tv.slot_id) hints.set(tv.slot_id, tv.rack_position ?? null);
    for (const cam of cameras) if (cam.slot_id && !hints.has(cam.slot_id)) hints.set(cam.slot_id, null);
    await this.ensureSlots(agentId, hints);

    for (const cam of cameras) await this.upsertCamera(agentId, cam);
    for (const tv of tvs) await this.upsertTv(agentId, tv);
    // Recompute every TV this agent owns so newly-arrived cameras flip blind TVs healthy.
    await this.recomputeForAgent(agentId);
  }

  /** Upsert slot rows so camera/tv FK references resolve. rack_position is NOT NULL, so a
   *  slot we only learned about from a camera defaults its rack_position to the slot_id. */
  private async ensureSlots(
    agentId: string,
    hints: Map<string, string | null>,
  ): Promise<void> {
    for (const [slotId, rack] of hints) {
      await this.pool.query(
        `INSERT INTO slots (slot_id, rack_position, host_agent_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (slot_id) DO UPDATE
           SET rack_position = COALESCE(EXCLUDED.rack_position, slots.rack_position),
               host_agent_id = EXCLUDED.host_agent_id`,
        [slotId, rack ?? slotId, agentId],
      );
    }
  }

  private async upsertCamera(agentId: string, cam: ReportedCamera): Promise<void> {
    await this.pool.query(
      `INSERT INTO cameras (camera_id, slot_id, host_agent_id, sfu_publish_track, status, last_heartbeat_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (camera_id) DO UPDATE
         SET slot_id = EXCLUDED.slot_id, host_agent_id = EXCLUDED.host_agent_id,
             sfu_publish_track = EXCLUDED.sfu_publish_track, status = EXCLUDED.status,
             last_heartbeat_at = now()`,
      [
        cam.camera_id,
        cam.slot_id ?? null,
        agentId,
        cam.sfu_publish_track ?? null,
        cam.status,
      ],
    );
  }

  private async upsertTv(agentId: string, tv: ReportedTv): Promise<void> {
    const protocol =
      tv.control_protocol ?? PLATFORM_TO_PROTOCOL[tv.platform];
    await this.pool.query(
      `INSERT INTO tvs (tv_id, platform, serial, firmware_version, slot_id, rack_position,
                        net_ip, mac, vlan, control_protocol, control_secret_ref,
                        host_agent_id, agent_status, last_heartbeat_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), 'provisioning')
       ON CONFLICT (tv_id) DO UPDATE
         SET platform = EXCLUDED.platform, serial = EXCLUDED.serial,
             firmware_version = EXCLUDED.firmware_version, slot_id = EXCLUDED.slot_id,
             rack_position = EXCLUDED.rack_position, net_ip = EXCLUDED.net_ip,
             mac = EXCLUDED.mac, vlan = EXCLUDED.vlan,
             control_protocol = EXCLUDED.control_protocol,
             control_secret_ref = EXCLUDED.control_secret_ref,
             host_agent_id = EXCLUDED.host_agent_id, agent_status = EXCLUDED.agent_status,
             last_heartbeat_at = now()`,
      [
        tv.tv_id,
        tv.platform,
        tv.serial ?? null,
        tv.firmware_version ?? null,
        tv.slot_id ?? null,
        tv.rack_position ?? null,
        tv.net_ip ?? null,
        tv.mac ?? null,
        tv.vlan ?? null,
        protocol,
        tv.control_secret_ref ?? null,
        agentId,
        tv.status,
      ],
    );
  }

  // ── Heartbeat (liveness + per-device status; cloud does NOT poll) ─────────
  async applyHeartbeat(
    agentId: string,
    tvs: Array<{ tv_id: string; status: TvStatus }>,
    cameras: Array<{
      camera_id: string;
      status: CameraStatus;
      sfu_publish_track?: string | null;
      slot_id?: string | null;
    }>,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE agents SET last_seen_at = now(), connected = true WHERE agent_id = $1",
      [agentId],
    );
    // A camera can reappear under a different slot (§9); make sure that slot exists first.
    const slotHints = new Map<string, string | null>();
    for (const cam of cameras) if (cam.slot_id) slotHints.set(cam.slot_id, null);
    if (slotHints.size) await this.ensureSlots(agentId, slotHints);
    for (const cam of cameras) {
      await this.pool.query(
        `UPDATE cameras
            SET status = $2, last_heartbeat_at = now(),
                sfu_publish_track = COALESCE($3, sfu_publish_track),
                slot_id = COALESCE($4, slot_id)
          WHERE camera_id = $1`,
        [cam.camera_id, cam.status, cam.sfu_publish_track ?? null, cam.slot_id ?? null],
      );
      await this.emitCamera(cam.camera_id);
    }
    for (const tv of tvs) {
      await this.pool.query(
        "UPDATE tvs SET agent_status = $2, last_heartbeat_at = now() WHERE tv_id = $1",
        [tv.tv_id, tv.status],
      );
      await this.recomputeAndStore(tv.tv_id);
    }
  }

  /** On agent disconnect, mark its devices offline and recompute dependent TVs. */
  async markAgentDevicesOffline(agentId: string): Promise<void> {
    await this.setAgentConnected(agentId, false);
    await this.pool.query(
      "UPDATE cameras SET status = 'offline' WHERE host_agent_id = $1",
      [agentId],
    );
    const cams = await this.pool.query<{ camera_id: string }>(
      "SELECT camera_id FROM cameras WHERE host_agent_id = $1",
      [agentId],
    );
    for (const c of cams.rows) await this.emitCamera(c.camera_id);
    await this.pool.query(
      "UPDATE tvs SET agent_status = 'offline' WHERE host_agent_id = $1",
      [agentId],
    );
    await this.recomputeForAgent(agentId);
  }

  // ── Status recompute ──────────────────────────────────────────────────────
  private async recomputeForAgent(agentId: string): Promise<void> {
    const res = await this.pool.query<{ tv_id: string }>(
      "SELECT tv_id FROM tvs WHERE host_agent_id = $1",
      [agentId],
    );
    for (const row of res.rows) await this.recomputeAndStore(row.tv_id);
  }

  /** Recompute one TV's effective status; persist + emit only if it changed. */
  async recomputeAndStore(tvId: string): Promise<TvView | null> {
    const row = await this.fetchRow(tvId);
    if (!row) return null;
    const next = computeTvStatus({
      tvLastHeartbeatMs: ms(row.last_heartbeat_at),
      agentReported: row.agent_status,
      hasBinding: row.b_camera_id != null,
      cameraStatus: row.cam_status,
      cameraLastHeartbeatMs: ms(row.cam_hb),
      hasActiveReservation: row.r_held_by != null,
      nowMs: Date.now(),
      heartbeatTimeoutMs: this.config.heartbeatTimeoutSeconds * 1000,
    });
    if (next !== row.status) {
      await this.pool.query("UPDATE tvs SET status = $2 WHERE tv_id = $1", [
        tvId,
        next,
      ]);
      row.status = next;
    }
    const view = this.rowToView(row, null);
    this.events.emit("tv.updated", view);
    return view;
  }

  /** Recompute every TV (reconcile loop). */
  async recomputeAll(): Promise<void> {
    const res = await this.pool.query<{ tv_id: string }>("SELECT tv_id FROM tvs");
    for (const row of res.rows) await this.recomputeAndStore(row.tv_id);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────
  async listTvViews(forUserId: string | null): Promise<TvView[]> {
    const res = await this.pool.query<TvViewRow>(
      `${TV_VIEW_SELECT} ORDER BY t.rack_position NULLS LAST, t.tv_id`,
    );
    return res.rows.map((r) => this.rowToView(r, forUserId));
  }

  async getTvView(tvId: string, forUserId: string | null): Promise<TvView | null> {
    const row = await this.fetchRow(tvId);
    return row ? this.rowToView(row, forUserId) : null;
  }

  async listCameras(): Promise<Camera[]> {
    const res = await this.pool.query<{
      camera_id: string;
      slot_id: string | null;
      host_agent_id: string;
      sfu_publish_track: string | null;
      status: CameraStatus;
      last_heartbeat_at: Date | null;
    }>(
      `SELECT camera_id, slot_id, host_agent_id, sfu_publish_track, status, last_heartbeat_at
         FROM cameras ORDER BY camera_id`,
    );
    return res.rows.map((c) => ({
      camera_id: c.camera_id,
      slot_id: c.slot_id,
      host_agent_id: c.host_agent_id,
      sfu_publish_track: c.sfu_publish_track,
      status: c.status,
      last_heartbeat_at: iso(c.last_heartbeat_at),
    }));
  }

  async getCameraStatus(cameraId: string): Promise<CameraStatus | null> {
    const res = await this.pool.query<{ status: CameraStatus }>(
      "SELECT status FROM cameras WHERE camera_id = $1",
      [cameraId],
    );
    return res.rowCount ? res.rows[0]!.status : null;
  }

  private async fetchRow(tvId: string): Promise<TvViewRow | null> {
    const res = await this.pool.query<TvViewRow>(
      `${TV_VIEW_SELECT} WHERE t.tv_id = $1`,
      [tvId],
    );
    return res.rowCount ? res.rows[0]! : null;
  }

  private async emitCamera(cameraId: string): Promise<void> {
    const res = await this.pool.query<{
      camera_id: string;
      slot_id: string | null;
      host_agent_id: string;
      sfu_publish_track: string | null;
      status: CameraStatus;
      last_heartbeat_at: Date | null;
    }>(
      `SELECT camera_id, slot_id, host_agent_id, sfu_publish_track, status, last_heartbeat_at
         FROM cameras WHERE camera_id = $1`,
      [cameraId],
    );
    if (!res.rowCount) return;
    const c = res.rows[0]!;
    this.events.emit("camera.updated", {
      camera_id: c.camera_id,
      slot_id: c.slot_id,
      host_agent_id: c.host_agent_id,
      sfu_publish_track: c.sfu_publish_track,
      status: c.status,
      last_heartbeat_at: iso(c.last_heartbeat_at),
    });
  }

  private rowToView(r: TvViewRow, forUserId: string | null): TvView {
    const binding =
      r.b_camera_id != null
        ? {
            camera_id: r.b_camera_id,
            method: r.b_method!,
            confidence: r.b_confidence,
            last_verified_at: iso(r.b_verified),
            camera_status: (r.cam_status ?? "offline") as CameraStatus,
          }
        : null;
    const reservation =
      r.r_held_by != null
        ? {
            held_by: r.r_held_by,
            session_id: r.r_session!,
            lock_expires_at: iso(r.r_lock_exp)!,
            hard_expires_at: iso(r.r_hard_exp)!,
          }
        : null;

    const healthyBinding = binding != null && binding.camera_status === "online";
    const heldByOther =
      reservation != null && reservation.held_by !== forUserId;
    const testable =
      healthyBinding && r.status !== "offline" && r.status !== "provisioning" && !heldByOther;

    return {
      tv_id: r.tv_id,
      platform: r.platform,
      serial: r.serial,
      firmware_version: r.firmware_version,
      slot_id: r.slot_id,
      rack_position: r.rack_position,
      net_ip: r.net_ip,
      mac: r.mac,
      vlan: r.vlan,
      control_protocol: r.control_protocol,
      control_secret_ref: r.control_secret_ref,
      host_agent_id: r.host_agent_id,
      status: r.status,
      last_heartbeat_at: iso(r.last_heartbeat_at),
      binding,
      reservation,
      testable,
    };
  }
}
