// ASSIGN / CALIBRATE (spec §10 screen 2, §5).
//   · Calibrate (QR handshake): POST /tvs/:id/calibrate, show live progress from
//     calibration.update WS frames (scanning -> bound/no_match/timeout). Auto-binds on a match.
//   · Assign camera (manual): pick an online camera, POST /tvs/:id/binding {camera_id}.
//   · Unassign: DELETE /tvs/:id/binding.
// Re-runnable; the modal stays open so the operator can retry. Live binding changes arrive via
// tv.updated on the WS, so the underlying card refreshes on its own.
import { useEffect, useState } from "react";
import type {
  CalibrationUpdate,
  CloudToDashboard,
  TvView,
} from "@device-lab/contracts";
import * as api from "../lib/api.js";
import { usePools } from "../store/poolStore.js";
import { dashboardSocket } from "../lib/ws.js";

interface Props {
  tv: TvView;
  onClose: () => void;
}

type CalibState =
  | { phase: "idle" }
  | { phase: "running"; update: CalibrationUpdate | null }
  | { phase: "done"; update: CalibrationUpdate }
  | { phase: "error"; message: string };

export function AssignModal({ tv, onClose }: Props): JSX.Element {
  const { cameras } = usePools();
  const [calib, setCalib] = useState<CalibState>({ phase: "idle" });
  const [manualCamera, setManualCamera] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const onlineCameras = cameras.filter((c) => c.status === "online");

  // Subscribe to live calibration.update frames for THIS tv while calibrating.
  useEffect(() => {
    const off = dashboardSocket.onMessage((msg: CloudToDashboard) => {
      if (msg.type !== "calibration.update" || msg.tv_id !== tv.tv_id) return;
      setCalib((prev) => {
        if (prev.phase !== "running") return prev;
        if (msg.status === "scanning") return { phase: "running", update: msg };
        return { phase: "done", update: msg };
      });
    });
    return off;
  }, [tv.tv_id]);

  async function runCalibrate(): Promise<void> {
    setCalib({ phase: "running", update: null });
    try {
      // The HTTP response carries the terminal outcome; WS calibration.update frames stream the
      // intermediate "scanning" state. We honor whichever resolves the flow.
      const res = await api.calibrate(tv.tv_id);
      setCalib({
        phase: "done",
        update: {
          type: "calibration.update",
          tv_id: tv.tv_id,
          status: res.status,
          camera_id: res.camera_id,
          confidence: res.confidence,
        },
      });
    } catch (err) {
      setCalib({ phase: "error", message: err instanceof Error ? err.message : "calibrate failed" });
    }
  }

  async function runManualBind(): Promise<void> {
    if (!manualCamera) return;
    setManualBusy(true);
    setManualError(null);
    try {
      await api.createBinding(tv.tv_id, manualCamera);
      // tv.updated will refresh the card; reflect immediately in the modal too.
    } catch (err) {
      setManualError(err instanceof Error ? err.message : "assign failed");
    } finally {
      setManualBusy(false);
    }
  }

  async function runUnassign(): Promise<void> {
    setManualError(null);
    try {
      await api.deleteBinding(tv.tv_id);
    } catch (err) {
      setManualError(err instanceof Error ? err.message : "unassign failed");
    }
  }

  const calibStatus =
    calib.phase === "running"
      ? (calib.update?.status ?? "scanning")
      : calib.phase === "done"
        ? calib.update.status
        : null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Assign / Calibrate — {tv.tv_id}</h3>
        <div className="hint">
          Platform: {tv.platform} · Status: {tv.status} ·{" "}
          {tv.binding
            ? `Bound to ${tv.binding.camera_id} (${tv.binding.method})`
            : "no camera bound"}
        </div>

        {/* QR handshake */}
        <div className="modal-section">
          <strong>Calibrate (QR handshake)</strong>
          <p className="hint">
            Renders {tv.tv_id}'s code on its own screen, scans every camera feed, auto-binds the
            camera that sees it (method=qr_handshake).
          </p>
          <button
            className="primary"
            onClick={() => void runCalibrate()}
            disabled={calib.phase === "running"}
          >
            {calib.phase === "running" ? "Calibrating…" : "Run QR handshake"}
          </button>
          {calibStatus && (
            <div style={{ marginTop: 10 }}>
              <span className={`calib-status ${calibStatus}`}>
                {calibStatus === "scanning" && "Scanning camera feeds for the QR…"}
                {calibStatus === "bound" &&
                  `Bound to ${calib.phase === "done" ? (calib.update.camera_id ?? "?") : "?"}` +
                    (calib.phase === "done" && calib.update.confidence != null
                      ? ` (confidence ${calib.update.confidence})`
                      : "")}
                {calibStatus === "no_match" && "No camera saw the code — check the mount/feed."}
                {calibStatus === "timeout" && "Calibration timed out — try again."}
              </span>
            </div>
          )}
          {calib.phase === "error" && <div className="error-text">{calib.message}</div>}
        </div>

        {/* Manual assign */}
        <div className="modal-section">
          <strong>Assign camera (manual)</strong>
          <p className="hint">Fallback when the QR can't render on this TV (method=manual_confirm).</p>
          <div style={{ display: "flex", gap: 8 }}>
            <select value={manualCamera} onChange={(e) => setManualCamera(e.target.value)}>
              <option value="">Select an online camera…</option>
              {onlineCameras.map((c) => (
                <option key={c.camera_id} value={c.camera_id}>
                  {c.camera_id}
                  {c.slot_id ? ` @ ${c.slot_id}` : ""}
                </option>
              ))}
            </select>
            <button onClick={() => void runManualBind()} disabled={!manualCamera || manualBusy}>
              {manualBusy ? "Assigning…" : "Assign"}
            </button>
          </div>
          {onlineCameras.length === 0 && (
            <div className="hint" style={{ marginTop: 8 }}>
              No online cameras available.
            </div>
          )}
          {manualError && <div className="error-text">{manualError}</div>}
        </div>

        {/* Unassign */}
        {tv.binding && (
          <div className="modal-section">
            <strong>Unassign</strong>
            <p className="hint">Sever the camera↔TV link. The TV becomes controllable but blind.</p>
            <button className="danger" onClick={() => void runUnassign()}>
              Unassign camera
            </button>
          </div>
        )}

        <div className="modal-footer">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
