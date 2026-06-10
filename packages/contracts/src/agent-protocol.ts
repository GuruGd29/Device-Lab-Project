// WebSocket protocols. Two channels, both carrying JSON only (never media):
//   1. Agent  ↔ Cloud  (the control tunnel; agent authenticates with AGENT_SHARED_SECRET)
//   2. Dashboard ↔ Cloud (presence/live-status push + WebRTC signaling relay)
//
// The Python lab agent mirrors these shapes; the JSON Schema in schemas/ is generated
// from the agent side for validation.

import type {
  CameraStatus,
  ControlProtocol,
  Platform,
  TvStatus,
} from "./domain.js";
import type { RemoteKey } from "./keymap.js";
import type { AppInfo, InstallStatus, PackageKind } from "./builds.js";

// ────────────────────────────────────────────────────────────────────────────
// 1. Agent ↔ Cloud
// ────────────────────────────────────────────────────────────────────────────

/** A TV as the agent reports it (subset of the registry row; cloud owns the rest). */
export interface ReportedTv {
  tv_id: string;
  platform: Platform;
  control_protocol: ControlProtocol;
  serial?: string | null;
  firmware_version?: string | null;
  net_ip?: string | null;
  mac?: string | null;
  vlan?: string | null;
  slot_id?: string | null;
  rack_position?: string | null;
  control_secret_ref?: string | null;
  status: TvStatus;
}

export interface ReportedCamera {
  camera_id: string;
  slot_id?: string | null;
  sfu_publish_track?: string | null;
  status: CameraStatus;
}

// --- Agent → Cloud ---
export interface AgentHello {
  type: "agent.hello";
  agent_id: string;
  shared_secret: string;
  host: { hostname?: string; sfu_signaling_url: string; version: string };
}
/** Full inventory snapshot — sent on connect and whenever the device set changes. */
export interface AgentRegisterDevices {
  type: "agent.register_devices";
  agent_id: string;
  tvs: ReportedTv[];
  cameras: ReportedCamera[];
}
/** Periodic liveness + per-device status. Drives presence; cloud does NOT poll. */
export interface AgentHeartbeat {
  type: "agent.heartbeat";
  agent_id: string;
  tvs: Array<{ tv_id: string; status: TvStatus }>;
  cameras: Array<{
    camera_id: string;
    status: CameraStatus;
    sfu_publish_track?: string | null;
    slot_id?: string | null;
  }>;
}
/** Result of a calibration scan the cloud asked for. */
export interface CalibrationResult {
  type: "calibration.result";
  tv_id: string;
  matched: boolean;
  camera_id?: string; // the camera that SAW the tv_id QR
  confidence?: number; // 1.0 for a clean QR decode
}
/** Ack for a key press relayed down. */
export interface KeyAck {
  type: "key.ack";
  request_id: string;
  tv_id: string;
  ok: boolean;
  error?: string;
}
/** WebRTC signaling traveling agent→cloud→dashboard (SFU answer / ICE). */
export interface SignalFromAgent {
  type: "signal.answer" | "signal.candidate";
  tv_id: string;
  dashboard_session: string; // routes back to the right dashboard socket
  payload: unknown; // SDP or ICE candidate
}

/** Progress for an install job the cloud handed down. */
export interface InstallProgress {
  type: "install.progress";
  job_id: string;
  tv_id: string;
  status: InstallStatus;
  progress: number; // 0..1
  message?: string;
}
/** Installed-apps listing the cloud asked for (correlated by request_id). */
export interface AppListResult {
  type: "app.list.result";
  request_id: string;
  tv_id: string;
  apps: AppInfo[];
}
/** Ack for launch/uninstall/power (correlated by request_id). */
export interface AppAck {
  type: "app.ack";
  request_id: string;
  tv_id: string;
  ok: boolean;
  error?: string;
}

export type AgentToCloud =
  | AgentHello
  | AgentRegisterDevices
  | AgentHeartbeat
  | CalibrationResult
  | KeyAck
  | SignalFromAgent
  | InstallProgress
  | AppListResult
  | AppAck;

// --- Cloud → Agent ---
export interface AgentWelcome {
  type: "agent.welcome";
  heartbeat_interval_seconds: number;
}
export interface CalibrateStart {
  type: "calibrate.start";
  tv_id: string;
  code_payload: string; // what to render + look for (== tv_id, opaque to the agent)
}
export interface CalibrateClear {
  type: "calibrate.clear";
  tv_id: string;
}
export interface KeyPressDown {
  type: "key.press";
  request_id: string;
  tv_id: string;
  key: RemoteKey;
}
/** Ask the agent to ensure the camera's SFU track is live and ready to subscribe. */
export interface StreamRequest {
  type: "stream.request";
  tv_id: string;
  camera_id: string;
  dashboard_session: string;
}
export interface StreamTeardown {
  type: "stream.teardown";
  tv_id: string;
  dashboard_session: string;
}
/** WebRTC signaling traveling dashboard→cloud→agent (subscribe offer / ICE). */
export interface SignalToAgent {
  type: "signal.offer" | "signal.candidate";
  tv_id: string;
  dashboard_session: string;
  payload: unknown;
}
/** Connect/disconnect the persistent vendor control session for a TV. */
export interface TvConnect {
  type: "tv.connect";
  tv_id: string;
}
export interface TvDisconnect {
  type: "tv.disconnect";
  tv_id: string;
}

/** Install a previously-uploaded build onto a TV. The agent pulls it from download_url
 *  (adding the agent shared secret header) and runs the per-platform installer. */
export interface InstallBuild {
  type: "install.build";
  job_id: string;
  tv_id: string;
  build_id: string;
  download_url: string;
  package_kind: PackageKind;
  app_id?: string | null;
}
export interface AppLaunch {
  type: "app.launch";
  request_id: string;
  tv_id: string;
  app_id: string;
}
export interface AppList {
  type: "app.list";
  request_id: string;
  tv_id: string;
}
export interface AppUninstall {
  type: "app.uninstall";
  request_id: string;
  tv_id: string;
  app_id: string;
}
export interface TvPower {
  type: "tv.power";
  request_id: string;
  tv_id: string;
  on: boolean;
}

export type CloudToAgent =
  | AgentWelcome
  | CalibrateStart
  | CalibrateClear
  | KeyPressDown
  | StreamRequest
  | StreamTeardown
  | SignalToAgent
  | TvConnect
  | TvDisconnect
  | InstallBuild
  | AppLaunch
  | AppList
  | AppUninstall
  | TvPower;

// ────────────────────────────────────────────────────────────────────────────
// 2. Dashboard ↔ Cloud (presence push + signaling relay + lock countdown)
// ────────────────────────────────────────────────────────────────────────────

// --- Cloud → Dashboard ---
export interface PoolsSnapshot {
  type: "pools.snapshot";
  // TvView[] / Camera[] sent as plain JSON; typed on the dashboard side.
  tvs: unknown[];
  cameras: unknown[];
}
export interface TvUpdated {
  type: "tv.updated";
  tv: unknown; // TvView
}
export interface CameraUpdated {
  type: "camera.updated";
  camera: unknown; // Camera
}
export interface ReservationUpdated {
  type: "reservation.updated";
  tv_id: string;
  reservation:
    | { held_by: string; lock_expires_at: string; hard_expires_at: string }
    | null; // null = released/free
}
export interface CalibrationUpdate {
  type: "calibration.update";
  tv_id: string;
  status: "scanning" | "bound" | "no_match" | "timeout";
  camera_id?: string;
  confidence?: number;
}
export interface SignalToDashboard {
  type: "signal.answer" | "signal.candidate";
  tv_id: string;
  payload: unknown;
}
/** Soft error for a stream/signaling request (e.g. not the lock holder, no binding). */
export interface DashboardError {
  type: "error";
  scope: "stream" | "signaling";
  tv_id?: string;
  reason:
    | "not_holder"
    | "no_binding"
    | "agent_offline"
    | "camera_unhealthy"
    | "internal";
}

/** Live install-job progress for the holder's device view. `job` is an InstallJob. */
export interface InstallUpdate {
  type: "install.update";
  tv_id: string;
  job: unknown; // InstallJob
}

export type CloudToDashboard =
  | PoolsSnapshot
  | TvUpdated
  | CameraUpdated
  | ReservationUpdated
  | CalibrationUpdate
  | SignalToDashboard
  | DashboardError
  | InstallUpdate;

// --- Dashboard → Cloud ---
export interface DashboardHello {
  type: "dashboard.hello";
  token: string; // user session JWT
}
export interface SubscribeStream {
  type: "stream.subscribe";
  tv_id: string;
  session_id: string; // reservation session — must match the lock holder
}
export interface UnsubscribeStream {
  type: "stream.unsubscribe";
  tv_id: string;
}
export interface SignalFromDashboard {
  type: "signal.offer" | "signal.candidate";
  tv_id: string;
  payload: unknown;
}

export type DashboardToCloud =
  | DashboardHello
  | SubscribeStream
  | UnsubscribeStream
  | SignalFromDashboard;

/** Channels used in NATS / Redis pub-sub for fan-out of presence + reservation events. */
export const PUBSUB_SUBJECTS = {
  tvUpdated: "devicelab.tv.updated",
  cameraUpdated: "devicelab.camera.updated",
  reservationUpdated: "devicelab.reservation.updated",
  calibrationUpdate: "devicelab.calibration.update",
  installUpdate: "devicelab.install.update",
} as const;
