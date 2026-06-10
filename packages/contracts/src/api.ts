// REST contracts between the dashboard and the cloud control plane (spec §11).
// Request/response shapes only — transport-agnostic.

import type {
  BindingMethod,
  Camera,
  TestBlockReason,
  TvView,
} from "./domain.js";
import type { RemoteKey } from "./keymap.js";
import type { AppInfo, Build, InstallJob, InstallStatus } from "./builds.js";

// --- Auth ---
export interface LoginRequest {
  username: string;
  password: string;
}
export interface LoginResponse {
  token: string;
  user: { id: string; name: string; role: "operator" | "admin" };
}

// --- Registry / pools ---
// GET /tvs -> TvView[]   (binding + holder denormalized in)
export type ListTvsResponse = TvView[];
// GET /cameras -> Camera[]
export type ListCamerasResponse = Camera[];
// GET /tvs/:id -> TvView
export type GetTvResponse = TvView;

// --- Binding / calibration ---
// POST /tvs/:id/calibrate
export interface CalibrateResponse {
  method: "qr";
  status: "scanning" | "bound" | "no_match" | "timeout";
  camera_id?: string;
  confidence?: number;
}
// POST /tvs/:id/binding  { camera_id }  (manual_confirm)
export interface CreateBindingRequest {
  camera_id: string;
}
export interface CreateBindingResponse {
  tv_id: string;
  camera_id: string;
  method: BindingMethod;
}
// DELETE /tvs/:id/binding -> 200 (unassign)

// --- Reservation (atomic, spec §7) ---
// POST /tvs/:id/reserve {}
export interface ReserveSuccess {
  ok: true;
  session_id: string;
  lock_expires_at: string;
  hard_expires_at: string;
}
// 409 body when someone else holds it
export interface ReserveConflict {
  ok: false;
  held_by: string;
  lock_expires_at: string;
  hard_expires_at: string;
}
export type ReserveResponse = ReserveSuccess | ReserveConflict;

// POST /tvs/:id/heartbeat { session_id } -> renews lease
export interface ReservationHeartbeatRequest {
  session_id: string;
}
export interface ReservationHeartbeatResponse {
  ok: boolean;
  lock_expires_at?: string; // present when renewed
  reason?: "not_holder" | "expired"; // present when ok=false
}
// POST /tvs/:id/release { session_id } -> 200
export interface ReleaseRequest {
  session_id: string;
}
// POST /tvs/:id/force-release  (admin only) -> 200

// --- Runtime ---
// GET /tvs/:id/stream -> resolved from binding
export interface StreamResolution {
  tv_id: string;
  camera_id: string;
  sfu_track: string;
  signaling_url: string; // dashboard opens WS here (cloud relays to agent SFU)
  host_agent_id: string;
}
export interface StreamBlocked {
  blocked: true;
  reason: TestBlockReason;
}
export type StreamResponse = StreamResolution | StreamBlocked;

// POST /tvs/:id/key { session_id, key } -> 200 | 403 (non-holder)
export interface KeyPressRequest {
  session_id: string;
  key: RemoteKey;
}
export interface KeyPressResponse {
  ok: boolean;
  reason?: "not_holder" | "tv_unreachable" | "unsupported_key";
}

// --- Build library + on-device app management ---
// POST /builds  (multipart form-data: file=<build>, app_id?=<pkg>) -> { build }
export interface CreateBuildResponse {
  build: Build;
}
// GET /builds[?platform=tizen] -> Build[]
export type ListBuildsResponse = Build[];
// DELETE /builds/:build_id -> { ok }

// All of the following touch the TV control session, so they require the LOCK HOLDER.
// POST /tvs/:id/install { session_id, build_id } -> { job_id, status }
export interface InstallRequest {
  session_id: string;
  build_id: string;
}
export interface InstallResponse {
  job_id: string;
  status: InstallStatus;
}
// GET /install-jobs/:job_id -> InstallJob   (also pushed live over the dashboard WS)
export type GetInstallJobResponse = InstallJob;

// POST /tvs/:id/launch-app { session_id, app_id } -> { ok }
export interface LaunchAppRequest {
  session_id: string;
  app_id: string;
}
// POST /tvs/:id/list-apps { session_id } -> AppInfo[]
export interface ListAppsRequest {
  session_id: string;
}
export type ListAppsResponse = AppInfo[];
// POST /tvs/:id/uninstall-app { session_id, app_id } -> { ok }
export interface UninstallAppRequest {
  session_id: string;
  app_id: string;
}
// POST /tvs/:id/power { session_id, on: boolean } -> { ok }
export interface PowerRequest {
  session_id: string;
  on: boolean;
}
export interface TvActionResponse {
  ok: boolean;
  reason?: "not_holder" | "tv_unreachable" | "unsupported" | "no_such_build";
}

/** Uniform error envelope for non-2xx responses. */
export interface ApiError {
  error: string;
  message: string;
  detail?: unknown;
}
