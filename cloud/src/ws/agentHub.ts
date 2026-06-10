// Agent control tunnel (cloud ↔ lab agent). JSON only — control + WebRTC signaling.
// The agent authenticates with AGENT_SHARED_SECRET in its hello frame. This hub:
//   · ingests device registration + heartbeats (drives presence; cloud never polls)
//   · correlates request/response for key presses (request_id) and calibration (tv_id)
//   · relays WebRTC signaling between dashboards and the agent's SFU
// Media NEVER flows here.
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  AgentToCloud,
  AppAck,
  AppInfo,
  CalibrationResult,
  CloudToAgent,
  InstallProgress,
  KeyAck,
  PackageKind,
  RemoteKey,
} from "@device-lab/contracts";
import type { DbPool } from "../db.js";
import type { Config } from "../config.js";
import type { RegistryService } from "../services/registry.js";
import { log } from "../lib/log.js";

interface Pending<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

type DashboardSignalHandler = (
  tvId: string,
  dashboardSession: string,
  msg: { type: "signal.answer" | "signal.candidate"; payload: unknown },
) => void;

export class AgentHub {
  private readonly agents = new Map<string, WebSocket>(); // agent_id -> socket
  private readonly socketAgent = new Map<WebSocket, string>(); // reverse
  private readonly pendingKeys = new Map<string, Pending<KeyAck>>();
  private readonly pendingCalibrations = new Map<string, Pending<CalibrationResult>>();
  private readonly pendingAppAcks = new Map<string, Pending<AppAck>>();
  private readonly pendingAppLists = new Map<string, Pending<AppInfo[]>>();
  private dashboardSignalHandler: DashboardSignalHandler | null = null;
  private installProgressHandler:
    | ((p: InstallProgress) => void)
    | null = null;

  constructor(
    private readonly pool: DbPool,
    private readonly config: Config,
    private readonly registry: RegistryService,
  ) {}

  /** Dashboard hub registers here to receive SFU answers/ICE bound for a dashboard. */
  onSignalToDashboard(handler: DashboardSignalHandler): void {
    this.dashboardSignalHandler = handler;
  }

  /** InstallService registers here to receive install.progress frames from agents. */
  onInstallProgress(handler: (p: InstallProgress) => void): void {
    this.installProgressHandler = handler;
  }

  isConnected(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────
  handleConnection(ws: WebSocket): void {
    ws.on("message", (data) => {
      let msg: AgentToCloud;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        log.warn("agent sent non-JSON frame");
        return;
      }
      this.onMessage(ws, msg).catch((err) =>
        log.error("agent message handler failed", { err: String(err) }),
      );
    });
    ws.on("close", () => this.onClose(ws));
    ws.on("error", (err) => log.warn("agent socket error", { err: String(err) }));
  }

  private async onMessage(ws: WebSocket, msg: AgentToCloud): Promise<void> {
    switch (msg.type) {
      case "agent.hello": {
        if (msg.shared_secret !== this.config.agentSharedSecret) {
          log.warn("agent failed auth", { agent_id: msg.agent_id });
          ws.close(4401, "bad shared secret");
          return;
        }
        // Evict a stale socket for the same agent id.
        const prior = this.agents.get(msg.agent_id);
        if (prior && prior !== ws) prior.close(4000, "superseded");
        this.agents.set(msg.agent_id, ws);
        this.socketAgent.set(ws, msg.agent_id);
        await this.registry.upsertAgent({
          agent_id: msg.agent_id,
          hostname: msg.host.hostname,
          sfu_signaling_url: msg.host.sfu_signaling_url,
          version: msg.host.version,
        });
        this.send(ws, {
          type: "agent.welcome",
          heartbeat_interval_seconds: Math.max(
            5,
            Math.floor(this.config.heartbeatTimeoutSeconds / 2),
          ),
        });
        log.info("agent connected", { agent_id: msg.agent_id });
        return;
      }
      case "agent.register_devices":
        await this.registry.registerDevices(msg.agent_id, msg.tvs, msg.cameras);
        return;
      case "agent.heartbeat":
        await this.registry.applyHeartbeat(msg.agent_id, msg.tvs, msg.cameras);
        return;
      case "calibration.result": {
        const pending = this.pendingCalibrations.get(msg.tv_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCalibrations.delete(msg.tv_id);
          pending.resolve(msg);
        }
        return;
      }
      case "key.ack": {
        const pending = this.pendingKeys.get(msg.request_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingKeys.delete(msg.request_id);
          pending.resolve(msg);
        }
        return;
      }
      case "signal.answer":
      case "signal.candidate":
        this.dashboardSignalHandler?.(msg.tv_id, msg.dashboard_session, {
          type: msg.type,
          payload: msg.payload,
        });
        return;
      case "install.progress":
        this.installProgressHandler?.(msg);
        return;
      case "app.list.result": {
        const pending = this.pendingAppLists.get(msg.request_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingAppLists.delete(msg.request_id);
          pending.resolve(msg.apps);
        }
        return;
      }
      case "app.ack": {
        const pending = this.pendingAppAcks.get(msg.request_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingAppAcks.delete(msg.request_id);
          pending.resolve(msg);
        }
        return;
      }
    }
  }

  private onClose(ws: WebSocket): void {
    const agentId = this.socketAgent.get(ws);
    this.socketAgent.delete(ws);
    if (!agentId) return;
    if (this.agents.get(agentId) === ws) this.agents.delete(agentId);
    log.warn("agent disconnected", { agent_id: agentId });
    this.registry
      .markAgentDevicesOffline(agentId)
      .catch((err) => log.error("offline sweep failed", { err: String(err) }));
  }

  // ── Outbound (cloud → agent) ───────────────────────────────────────────────
  private send(ws: WebSocket, msg: CloudToAgent): void {
    ws.send(JSON.stringify(msg));
  }

  private async socketForTv(tvId: string): Promise<WebSocket | null> {
    const res = await this.pool.query<{ host_agent_id: string }>(
      "SELECT host_agent_id FROM tvs WHERE tv_id = $1",
      [tvId],
    );
    if (!res.rowCount) return null;
    return this.agents.get(res.rows[0]!.host_agent_id) ?? null;
  }

  /** Relay a soft-remote key down to the owning agent; resolve on its ack. */
  async pressKey(tvId: string, key: RemoteKey): Promise<KeyAck> {
    const ws = await this.socketForTv(tvId);
    if (!ws) throw new Error("agent_offline");
    const requestId = randomUUID();
    const ack = new Promise<KeyAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingKeys.delete(requestId);
        reject(new Error("key_timeout"));
      }, 5000);
      this.pendingKeys.set(requestId, { resolve, reject, timer });
    });
    this.send(ws, { type: "key.press", request_id: requestId, tv_id: tvId, key });
    return ack;
  }

  /**
   * Run a QR-handshake calibration: render `codePayload` (== tv_id) on the TV and scan
   * every camera feed. Resolves with which camera SAW it. Always clears the QR after.
   */
  async calibrate(tvId: string, codePayload: string): Promise<CalibrationResult> {
    const ws = await this.socketForTv(tvId);
    if (!ws) throw new Error("agent_offline");
    const result = new Promise<CalibrationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalibrations.delete(tvId);
        reject(new Error("calibration_timeout"));
      }, this.config.calibrationTimeoutSeconds * 1000);
      this.pendingCalibrations.set(tvId, { resolve, reject, timer });
    });
    this.send(ws, { type: "calibrate.start", tv_id: tvId, code_payload: codePayload });
    try {
      return await result;
    } finally {
      this.send(ws, { type: "calibrate.clear", tv_id: tvId });
    }
  }

  async requestStream(
    tvId: string,
    cameraId: string,
    dashboardSession: string,
  ): Promise<void> {
    const ws = await this.socketForTv(tvId);
    if (!ws) throw new Error("agent_offline");
    this.send(ws, {
      type: "stream.request",
      tv_id: tvId,
      camera_id: cameraId,
      dashboard_session: dashboardSession,
    });
  }

  async teardownStream(tvId: string, dashboardSession: string): Promise<void> {
    const ws = await this.socketForTv(tvId);
    if (!ws) return;
    this.send(ws, { type: "stream.teardown", tv_id: tvId, dashboard_session: dashboardSession });
  }

  /** Relay a WebRTC offer/ICE candidate from a dashboard down to the agent's SFU. */
  async relaySignalToAgent(
    tvId: string,
    dashboardSession: string,
    type: "signal.offer" | "signal.candidate",
    payload: unknown,
  ): Promise<void> {
    const ws = await this.socketForTv(tvId);
    if (!ws) throw new Error("agent_offline");
    this.send(ws, { type, tv_id: tvId, dashboard_session: dashboardSession, payload });
  }

  /** Open/refresh the persistent vendor control session for a TV. */
  async connectTv(tvId: string): Promise<void> {
    const ws = await this.socketForTv(tvId);
    if (ws) this.send(ws, { type: "tv.connect", tv_id: tvId });
  }

  // ── Build install + app management (the "other TV options") ─────────────────

  /** Hand an install job to the owning agent. Progress arrives async via install.progress. */
  async installBuild(args: {
    tvId: string;
    buildId: string;
    jobId: string;
    downloadUrl: string;
    packageKind: PackageKind;
    appId: string | null;
  }): Promise<void> {
    const ws = await this.socketForTv(args.tvId);
    if (!ws) throw new Error("agent_offline");
    this.send(ws, {
      type: "install.build",
      job_id: args.jobId,
      tv_id: args.tvId,
      build_id: args.buildId,
      download_url: args.downloadUrl,
      package_kind: args.packageKind,
      app_id: args.appId,
    });
  }

  async launchApp(tvId: string, appId: string): Promise<AppAck> {
    return this.appAction(tvId, (rid) => ({
      type: "app.launch",
      request_id: rid,
      tv_id: tvId,
      app_id: appId,
    }));
  }

  async uninstallApp(tvId: string, appId: string): Promise<AppAck> {
    return this.appAction(tvId, (rid) => ({
      type: "app.uninstall",
      request_id: rid,
      tv_id: tvId,
      app_id: appId,
    }));
  }

  async power(tvId: string, on: boolean): Promise<AppAck> {
    return this.appAction(tvId, (rid) => ({
      type: "tv.power",
      request_id: rid,
      tv_id: tvId,
      on,
    }));
  }

  private async appAction(
    tvId: string,
    build: (requestId: string) => CloudToAgent,
  ): Promise<AppAck> {
    const ws = await this.socketForTv(tvId);
    if (!ws) throw new Error("agent_offline");
    const requestId = randomUUID();
    const ack = new Promise<AppAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAppAcks.delete(requestId);
        reject(new Error("app_timeout"));
      }, 30_000);
      this.pendingAppAcks.set(requestId, { resolve, reject, timer });
    });
    this.send(ws, build(requestId));
    return ack;
  }

  async listApps(tvId: string): Promise<AppInfo[]> {
    const ws = await this.socketForTv(tvId);
    if (!ws) throw new Error("agent_offline");
    const requestId = randomUUID();
    const result = new Promise<AppInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAppLists.delete(requestId);
        reject(new Error("app_timeout"));
      }, 30_000);
      this.pendingAppLists.set(requestId, { resolve, reject, timer });
    });
    this.send(ws, { type: "app.list", request_id: requestId, tv_id: tvId });
    return result;
  }
}
