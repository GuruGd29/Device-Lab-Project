// TV card (spec §10 screen 1). Live, color-coded status + binding state + lock holder/ETA.
// The Test button is gated client-side (computeTestability) so it reacts instantly to WS pushes;
// the block reason shows on hover instead of a dead grey button.
import type { TvView } from "@device-lab/contracts";
import { blockReasonText, computeTestability } from "../lib/testable.js";
import { minutesLeft } from "../lib/time.js";

interface Props {
  tv: TvView;
  myUserId: string;
  isAdmin: boolean;
  now: number;
  onTest: (tv: TvView) => void;
  onAssign: (tv: TvView) => void;
  onForceRelease: (tv: TvView) => void;
}

export function TvCard({
  tv,
  myUserId,
  isAdmin,
  now,
  onTest,
  onAssign,
  onForceRelease,
}: Props): JSX.Element {
  const { testable, reason } = computeTestability(tv, myUserId);

  const heldByMe = tv.reservation?.held_by === myUserId;
  const reservationLabel = (() => {
    if (!tv.reservation) return null;
    const mins = minutesLeft(tv.reservation.lock_expires_at, now);
    const who = heldByMe ? "you" : tv.reservation.held_by;
    return `In use by ${who}, ~${mins}m left`;
  })();

  return (
    <div className={`card status-${tv.status}`}>
      <div className="row">
        <div>
          <div className="title">{tv.tv_id}</div>
          <div className="sub">
            {tv.platform}
            {tv.rack_position ? ` · ${tv.rack_position}` : ""}
            {tv.firmware_version ? ` · fw ${tv.firmware_version}` : ""}
          </div>
        </div>
        <span className={`badge ${tv.status}`}>{tv.status.replace("_", " ")}</span>
      </div>

      <div className="card-meta">
        {/* Binding state: bound camera id + method + confidence, or "no camera". */}
        {tv.binding ? (
          <div>
            <span className="k">Camera:</span> {tv.binding.camera_id} ({tv.binding.method}
            {tv.binding.confidence != null ? `, conf ${tv.binding.confidence}` : ""}) ·{" "}
            <span className={`badge ${tv.binding.camera_status}`}>{tv.binding.camera_status}</span>
          </div>
        ) : (
          <div>
            <span className="k">Camera:</span> no camera
          </div>
        )}

        {/* Lock holder + ETA when in use. */}
        {reservationLabel && (
          <div style={{ marginTop: 4 }}>
            <span className="k">Lock:</span> {reservationLabel}
          </div>
        )}
      </div>

      <div className="card-actions">
        <button
          className="primary"
          disabled={!testable}
          title={!testable && reason ? blockReasonText(reason) : "Open device view"}
          onClick={() => onTest(tv)}
        >
          Test
        </button>
        <button onClick={() => onAssign(tv)}>Assign / Calibrate</button>
        {/* Admin-only: break a stuck lock (spec §10 screen 4). Recalibration is the same
            Assign/Calibrate modal, available to all users. */}
        {isAdmin && tv.reservation && (
          <button
            className="danger"
            title="Force-release this lock (admin)"
            onClick={() => onForceRelease(tv)}
          >
            Force-release
          </button>
        )}
      </div>
    </div>
  );
}
