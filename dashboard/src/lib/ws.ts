// Dashboard WebSocket client (cloud ↔ browser, cloud/src/ws/dashboardHub.ts).
//
// Lifecycle: open ws://host/dashboard, send {type:"dashboard.hello", token} as the FIRST frame
// (the hub closes 4401 on anything else / a bad token), then receive the initial pools.snapshot
// and a stream of live CloudToDashboard pushes. The same socket carries WebRTC signaling:
// the dashboard sends signal.offer / signal.candidate up and receives signal.answer /
// signal.candidate down for the TV it is streaming.
//
// We auto-reconnect with backoff because presence is push-only (no polling per spec §8). On
// reconnect the hub re-sends a fresh pools.snapshot, so the store re-syncs automatically.
import type {
  CloudToDashboard,
  DashboardToCloud,
} from "@device-lab/contracts";
import { DASHBOARD_WS_URL } from "./config.js";

type InboundHandler = (msg: CloudToDashboard) => void;
type StatusHandler = (connected: boolean) => void;

export class DashboardSocket {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private closedByUs = false;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inboundHandlers = new Set<InboundHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();

  /** (Re)connect using the given JWT. Idempotent for the same live socket. */
  connect(token: string): void {
    this.token = token;
    this.closedByUs = false;
    this.open();
  }

  /** Permanently close the socket (logout / app teardown). */
  disconnect(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  onMessage(handler: InboundHandler): () => void {
    this.inboundHandlers.add(handler);
    return () => this.inboundHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** Send a typed dashboard→cloud frame. Drops silently if not open (caller re-sends on reconnect). */
  send(msg: DashboardToCloud): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private open(): void {
    if (!this.token) return;
    // Avoid duplicate sockets.
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const ws = new WebSocket(DASHBOARD_WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      // First frame MUST be the authenticated hello (hub requirement).
      this.send({ type: "dashboard.hello", token: this.token! });
      this.emitStatus(true);
    };

    ws.onmessage = (ev) => {
      let msg: CloudToDashboard;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      for (const h of this.inboundHandlers) h(msg);
    };

    ws.onclose = () => {
      this.emitStatus(false);
      this.ws = null;
      if (!this.closedByUs) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow; reconnection is handled there.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
      this.open();
    }, delay);
  }

  private emitStatus(connected: boolean): void {
    for (const h of this.statusHandlers) h(connected);
  }
}

// One shared socket for the whole app.
export const dashboardSocket = new DashboardSocket();
