// Client-side recomputation of the Test gate (spec §10 / domain.ts TvView.testable).
//
// The cloud already computes `testable` per caller in the TvView, but the dashboard recomputes
// it locally so the button reacts instantly to live WS pushes (binding/reservation/status) and
// so we can surface a precise *block reason* on hover instead of a dead grey button.
//
// Rule (matches domain.ts comment + spec §10):
//   testable = has a healthy bound camera (binding && binding.camera_status === "online")
//              AND status NOT in {offline, unhealthy, provisioning}
//              AND (no reservation OR reservation.held_by === my user id)
import type { TestBlockReason, TvView } from "@device-lab/contracts";

export interface Testability {
  testable: boolean;
  reason: TestBlockReason | null;
}

export function computeTestability(tv: TvView, myUserId: string): Testability {
  if (tv.status === "offline") return { testable: false, reason: "tv_offline" };
  if (tv.status === "unhealthy") return { testable: false, reason: "tv_unhealthy" };
  if (tv.status === "provisioning") {
    // No dedicated reason enum value; provisioning TVs are simply not testable yet.
    return { testable: false, reason: "tv_unhealthy" };
  }
  if (!tv.binding) return { testable: false, reason: "no_binding" };
  if (tv.binding.camera_status === "offline") {
    return { testable: false, reason: "camera_offline" };
  }
  if (tv.binding.camera_status === "unhealthy") {
    return { testable: false, reason: "camera_unhealthy" };
  }
  // binding.camera_status === "online" here.
  if (tv.reservation && tv.reservation.held_by !== myUserId) {
    return { testable: false, reason: "held_by_other" };
  }
  return { testable: true, reason: null };
}

const REASON_TEXT: Record<TestBlockReason, string> = {
  no_binding: "No camera bound — calibrate or assign a camera first.",
  camera_offline: "Bound camera is offline.",
  camera_unhealthy: "Bound camera stopped publishing (unhealthy).",
  tv_offline: "TV heartbeat lost (offline).",
  tv_unhealthy: "TV is unhealthy.",
  held_by_other: "In use by another tester.",
};

export function blockReasonText(reason: TestBlockReason): string {
  return REASON_TEXT[reason];
}
