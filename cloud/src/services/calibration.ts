// Calibration — confirming the camera↔TV binding (spec §5). A camera can't know what it's
// looking at; calibration captures it once and self-heals on re-run.
//
// QR handshake (the recommended, near-zero-error path):
//   1. Push the TV's own tv_id as a fullscreen QR onto THAT TV's screen (via its control
//      channel) and scan every camera feed.
//   2. The camera that SEES the code is the one pointed at this TV → bind it
//      (method=qr_handshake, confidence=1.0).
//   3. Clear the QR (the agent hub does this in its finally).
import type { CalibrateResponse } from "@device-lab/contracts";
import type { AgentHub } from "../ws/agentHub.js";
import type { BindingService } from "./binding.js";
import type { EventBus } from "../lib/events.js";
import { log } from "../lib/log.js";

export class CalibrationService {
  constructor(
    private readonly agentHub: AgentHub,
    private readonly bindings: BindingService,
    private readonly events: EventBus,
  ) {}

  async calibrate(tvId: string, userId: string | null): Promise<CalibrateResponse> {
    this.events.emit("calibration.update", { tv_id: tvId, status: "scanning" });
    try {
      // code_payload == tv_id: opaque to the agent, it just renders + looks for this string.
      const result = await this.agentHub.calibrate(tvId, tvId);
      if (result.matched && result.camera_id) {
        const confidence = result.confidence ?? 1.0;
        const bound = await this.bindings.createFromCalibration(
          tvId,
          result.camera_id,
          confidence,
          userId,
        );
        if (!bound.ok) {
          this.events.emit("calibration.update", { tv_id: tvId, status: "no_match" });
          return { method: "qr", status: "no_match" };
        }
        this.events.emit("calibration.update", {
          tv_id: tvId,
          status: "bound",
          camera_id: result.camera_id,
          confidence,
        });
        log.info("calibration bound", { tv_id: tvId, camera_id: result.camera_id });
        return {
          method: "qr",
          status: "bound",
          camera_id: result.camera_id,
          confidence,
        };
      }
      this.events.emit("calibration.update", { tv_id: tvId, status: "no_match" });
      return { method: "qr", status: "no_match" };
    } catch (err) {
      const timeout = String(err).includes("timeout");
      const status = timeout ? "timeout" : "no_match";
      this.events.emit("calibration.update", { tv_id: tvId, status });
      log.warn("calibration failed", { tv_id: tvId, err: String(err) });
      return { method: "qr", status };
    }
  }
}
