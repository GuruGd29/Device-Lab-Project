// Dashboard channel (cloud ↔ browser). Pushes live pool/reservation/calibration state and
// relays WebRTC signaling to the agent's SFU. Every stream subscribe and signaling frame is
// validated against the reservation lock — a non-holder cannot peek at or drive a TV.
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  CloudToDashboard,
  DashboardToCloud,
} from "@device-lab/contracts";
import type { AuthUser } from "../auth.js";
import { verifyToken } from "../auth.js";
import type { Config } from "../config.js";
import type { EventBus } from "../lib/events.js";
import type { RegistryService } from "../services/registry.js";
import type { ReservationService } from "../services/reservation.js";
import type { BindingService } from "../services/binding.js";
import type { AgentHub } from "./agentHub.js";
import { log } from "../lib/log.js";

interface Conn {
  ws: WebSocket;
  user: AuthUser;
  /** Routing id for signaling — distinct from a reservation session_id. */
  dashboardSession: string;
  /** TVs this socket is actively streaming, so we can tear down on disconnect. */
  streaming: Set<string>;
}

export class DashboardHub {
  private readonly conns = new Map<string, Conn>(); // dashboardSession -> conn

  constructor(
    private readonly config: Config,
    private readonly registry: RegistryService,
    private readonly reservations: ReservationService,
    private readonly bindings: BindingService,
    private readonly agentHub: AgentHub,
    private readonly events: EventBus,
  ) {
    // Fan out live state to every connected dashboard.
    this.events.on("tv.updated", (tv) => this.broadcast({ type: "tv.updated", tv }));
    this.events.on("camera.updated", (camera) =>
      this.broadcast({ type: "camera.updated", camera }),
    );
    this.events.on("reservation.updated", (e) =>
      this.broadcast({ type: "reservation.updated", tv_id: e.tv_id, reservation: e.reservation }),
    );
    this.events.on("calibration.update", (e) =>
      this.broadcast({
        type: "calibration.update",
        tv_id: e.tv_id,
        status: e.status,
        camera_id: e.camera_id,
        confidence: e.confidence,
      }),
    );
    this.events.on("install.update", (e) =>
      this.broadcast({ type: "install.update", tv_id: e.tv_id, job: e.job }),
    );
    // SFU answers / ICE coming up from the agent get routed to the originating socket.
    this.agentHub.onSignalToDashboard((_tvId, dashboardSession, msg) => {
      const conn = this.conns.get(dashboardSession);
      if (conn) this.sendTo(conn, { type: msg.type, tv_id: _tvId, payload: msg.payload });
    });
  }

  handleConnection(ws: WebSocket): void {
    let conn: Conn | null = null;
    ws.on("message", (data) => {
      let msg: DashboardToCloud;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      // First frame must be the authenticated hello.
      if (!conn) {
        if (msg.type !== "dashboard.hello") {
          ws.close(4401, "expected dashboard.hello");
          return;
        }
        const user = verifyToken(msg.token, this.config.jwtSecret);
        if (!user) {
          ws.close(4401, "bad token");
          return;
        }
        conn = {
          ws,
          user,
          dashboardSession: randomUUID(),
          streaming: new Set(),
        };
        this.conns.set(conn.dashboardSession, conn);
        this.sendSnapshot(conn).catch((err) =>
          log.error("snapshot failed", { err: String(err) }),
        );
        return;
      }
      this.onMessage(conn, msg).catch((err) =>
        log.error("dashboard message handler failed", { err: String(err) }),
      );
    });
    ws.on("close", () => {
      if (!conn) return;
      // Tear down any media this socket was subscribed to (don't leave ghost streams).
      for (const tvId of conn.streaming) {
        this.agentHub.teardownStream(tvId, conn.dashboardSession).catch(() => {});
      }
      this.conns.delete(conn.dashboardSession);
    });
    ws.on("error", (err) => log.warn("dashboard socket error", { err: String(err) }));
  }

  private async onMessage(conn: Conn, msg: DashboardToCloud): Promise<void> {
    switch (msg.type) {
      case "dashboard.hello":
        return; // already handled
      case "stream.subscribe": {
        // Authorization: only the live lock holder may open the media path.
        const holder = await this.reservations.isHolder(msg.tv_id, msg.session_id);
        if (!holder) {
          this.sendTo(conn, { type: "error", scope: "stream", tv_id: msg.tv_id, reason: "not_holder" });
          log.warn("stream.subscribe rejected: not holder", {
            tv_id: msg.tv_id,
            user: conn.user.id,
          });
          return;
        }
        const cameraId = await this.bindings.getBoundCamera(msg.tv_id);
        if (!cameraId) {
          this.sendTo(conn, { type: "error", scope: "stream", tv_id: msg.tv_id, reason: "no_binding" });
          log.warn("stream.subscribe rejected: no binding", { tv_id: msg.tv_id });
          return;
        }
        conn.streaming.add(msg.tv_id);
        try {
          await this.agentHub.requestStream(msg.tv_id, cameraId, conn.dashboardSession);
        } catch {
          conn.streaming.delete(msg.tv_id);
          this.sendTo(conn, { type: "error", scope: "stream", tv_id: msg.tv_id, reason: "agent_offline" });
        }
        return;
      }
      case "stream.unsubscribe":
        conn.streaming.delete(msg.tv_id);
        await this.agentHub.teardownStream(msg.tv_id, conn.dashboardSession);
        return;
      case "signal.offer":
      case "signal.candidate":
        // Only forward signaling for TVs this socket is actively (and legitimately) streaming.
        if (!conn.streaming.has(msg.tv_id)) {
          log.warn("dropped signaling for unsubscribed tv", { tv_id: msg.tv_id });
          return;
        }
        await this.agentHub.relaySignalToAgent(
          msg.tv_id,
          conn.dashboardSession,
          msg.type,
          msg.payload,
        );
        return;
    }
  }

  private async sendSnapshot(conn: Conn): Promise<void> {
    const [tvs, cameras] = await Promise.all([
      this.registry.listTvViews(conn.user.id),
      this.registry.listCameras(),
    ]);
    this.sendTo(conn, { type: "pools.snapshot", tvs, cameras });
  }

  private sendTo(conn: Conn, msg: CloudToDashboard): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: CloudToDashboard): void {
    const payload = JSON.stringify(msg);
    for (const conn of this.conns.values()) {
      if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(payload);
    }
  }
}
