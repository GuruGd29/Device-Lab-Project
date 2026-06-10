// Camera card (spec §10 screen 1, camera pool). Live, color-coded status. A camera is a thing
// that produces a stream; the binding (1 camera : 1 TV) lives on the TV side.
import type { Camera } from "@device-lab/contracts";

// Map CameraStatus onto the same status- CSS classes used for TVs for consistent color coding:
// online=green, unhealthy/offline=red.
function statusClass(status: Camera["status"]): string {
  switch (status) {
    case "online":
      return "free";
    case "unhealthy":
      return "unhealthy";
    case "offline":
      return "offline";
    default:
      return "no_camera";
  }
}

export function CameraCard({ camera }: { camera: Camera }): JSX.Element {
  return (
    <div className={`card status-${camera.status === "online" ? "free" : camera.status}`}>
      <div className="row">
        <div>
          <div className="title">{camera.camera_id}</div>
          <div className="sub">{camera.slot_id ?? "unslotted"}</div>
        </div>
        <span className={`badge ${statusClass(camera.status)}`}>{camera.status}</span>
      </div>
      <div className="card-meta">
        <div>
          <span className="k">SFU track:</span>{" "}
          {camera.sfu_publish_track ?? <em className="hint">not publishing</em>}
        </div>
        {camera.last_heartbeat_at && (
          <div>
            <span className="k">Last seen:</span>{" "}
            {new Date(camera.last_heartbeat_at).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
}
