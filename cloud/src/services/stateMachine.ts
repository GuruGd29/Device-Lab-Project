// TV status derivation (spec §8 + the §9 reconcile table). Pure function so it can be
// unit-tested and reused by both the heartbeat path and the reconcile loop.
//
// Priority (highest first): provisioning > offline > no_camera > unhealthy > in_use > free.
// Rationale: tell the operator the most blocking truth. A held TV whose camera died reads
// "unhealthy" (not testable) — the holder is still carried separately in TvView.reservation.

import type { CameraStatus, TvStatus } from "@device-lab/contracts";

export interface StatusInputs {
  /** Last heartbeat the cloud saw for this TV (ms epoch), or null. */
  tvLastHeartbeatMs: number | null;
  /** Status the agent last reported for the TV (control-session health). */
  agentReported: TvStatus | null;
  hasBinding: boolean;
  /** Bound camera's reported status, or null when no camera/binding. */
  cameraStatus: CameraStatus | null;
  cameraLastHeartbeatMs: number | null;
  /** A reservation row exists whose lease AND hard ceiling are still in the future. */
  hasActiveReservation: boolean;
  nowMs: number;
  heartbeatTimeoutMs: number;
}

export function computeTvStatus(i: StatusInputs): TvStatus {
  // First pairing — respect the agent's explicit signal; out of Phase 1 runtime scope.
  if (i.agentReported === "provisioning") return "provisioning";

  const tvStale =
    i.tvLastHeartbeatMs == null ||
    i.nowMs - i.tvLastHeartbeatMs > i.heartbeatTimeoutMs;
  if (i.agentReported === "offline" || tvStale) return "offline";

  // Controllable but blind — no link at all.
  if (!i.hasBinding) return "no_camera";

  // Binding exists, but is the camera actually healthy AND publishing?
  // "Both online, camera stopped publishing -> unhealthy, NOT free" (spec §9).
  const camStale =
    i.cameraLastHeartbeatMs == null ||
    i.nowMs - i.cameraLastHeartbeatMs > i.heartbeatTimeoutMs;
  if (
    i.cameraStatus == null ||
    i.cameraStatus === "offline" ||
    i.cameraStatus === "unhealthy" ||
    camStale
  ) {
    return "unhealthy";
  }

  if (i.agentReported === "unhealthy") return "unhealthy";

  return i.hasActiveReservation ? "in_use" : "free";
}
