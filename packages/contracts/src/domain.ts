// Domain model — mirrors the Postgres schema in cloud/migrations/001_init.sql.
// This is the vocabulary the entire system (cloud, dashboard, agent) shares.

/** TV OS family. Determines which control adapter the lab agent uses. */
export type Platform = "tizen" | "webos" | "androidtv";

/** Reverse-engineered vendor control protocol, firmware-dependent. */
export type ControlProtocol = "samsung_ws" | "lg_ssap" | "androidtv_remote";

/**
 * TV lifecycle status. Drives the dashboard and gates the Test action.
 * A TV is only *testable* when `free` (or held by you) AND it has a healthy bound camera.
 */
export type TvStatus =
  | "provisioning" // first pairing in progress (out of Phase 1 scope, kept for completeness)
  | "free" // reachable, has a healthy bound camera, nobody holds it
  | "in_use" // reserved + actively held
  | "no_camera" // controllable but blind — no binding or bound camera gone → Test blocked
  | "unhealthy" // bound camera stopped publishing / stream bad
  | "offline"; // TV heartbeat lost

export type CameraStatus = "online" | "offline" | "unhealthy";

/** How a camera↔TV binding was established. */
export type BindingMethod = "qr_handshake" | "manual_confirm";

export const PLATFORM_TO_PROTOCOL: Record<Platform, ControlProtocol> = {
  tizen: "samsung_ws",
  webos: "lg_ssap",
  androidtv: "androidtv_remote",
};

/** Stable rack position; decouples physical slots from transient devices. */
export interface Slot {
  slot_id: string; // e.g. "rack-A/pos-03"
  rack_position: string;
  host_agent_id: string;
}

export interface Camera {
  camera_id: string;
  slot_id: string | null;
  host_agent_id: string;
  sfu_publish_track: string | null; // track/producer id on the SFU
  status: CameraStatus;
  last_heartbeat_at: string | null; // ISO8601
}

export interface Tv {
  tv_id: string;
  platform: Platform;
  serial: string | null;
  firmware_version: string | null; // protocols are firmware-dependent; store it
  slot_id: string | null;
  rack_position: string | null;
  net_ip: string | null;
  mac: string | null;
  vlan: string | null;
  control_protocol: ControlProtocol;
  control_secret_ref: string | null; // pointer to stored token/key/cert — NEVER the secret inline
  host_agent_id: string;
  status: TvStatus;
  last_heartbeat_at: string | null;
}

/** The one mutable link. One row per bound TV. Deleting = unassign. */
export interface Binding {
  tv_id: string;
  camera_id: string;
  method: BindingMethod;
  confidence: number | null; // 1.0 for QR match, null for manual
  bound_by: string | null;
  last_verified_at: string | null;
}

/** Exclusive reservation lock. Short renewed lease + a hard ceiling. */
export interface Reservation {
  tv_id: string;
  held_by: string; // user id
  session_id: string; // ties lock to a session, not a socket
  acquired_at: string;
  lock_expires_at: string; // renewed every heartbeat (the short lease)
  hard_expires_at: string; // max session window, never renewed
}

/** Denormalized view the dashboard renders per TV card. */
export interface TvView extends Tv {
  binding: {
    camera_id: string;
    method: BindingMethod;
    confidence: number | null;
    last_verified_at: string | null;
    camera_status: CameraStatus;
  } | null;
  reservation: {
    held_by: string;
    session_id: string;
    lock_expires_at: string;
    hard_expires_at: string;
  } | null;
  /** True iff free-or-held-by-caller AND a healthy camera is bound. The Test gate. */
  testable: boolean;
}

/**
 * Why a TV is or isn't testable — surfaced to the operator instead of a dead grey button.
 */
export type TestBlockReason =
  | "no_binding"
  | "camera_offline"
  | "camera_unhealthy"
  | "tv_offline"
  | "tv_unhealthy"
  | "held_by_other";
