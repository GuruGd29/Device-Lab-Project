// DEVICE VIEW (test) — spec §6 runtime loop, §10 screen 3. Gated on a healthy binding.
//
//   a. reserve the lock (409 => show holder + ETA, don't enter)
//   b. heartbeat every 15s; on lost lock surface a banner + exit; show live countdowns to
//      lock_expires_at (renewed lease) and hard_expires_at (the hard ceiling)
//   c. WebRTC receive-only stream over the dashboard WS (media stays on the local link)
//   d. soft remote keypad + physical arrow/enter bindings, lock-validated server-side
//   e. End session => release + stream.unsubscribe + close PC + stop heartbeat (also on unmount)
import { useCallback, useEffect, useRef } from "react";
import type { RemoteKey, TvView } from "@device-lab/contracts";
import { isRemoteKey } from "@device-lab/contracts";
import { useReservation } from "../hooks/useReservation.js";
import { useWebrtcStream } from "../hooks/useWebrtcStream.js";
import { useNow } from "../hooks/useNow.js";
import { formatClock, formatCountdown } from "../lib/time.js";
import { SoftRemote } from "./SoftRemote.js";
import { PowerControls } from "./PowerControls.js";
import { BuildsPanel } from "./BuildsPanel.js";
import { AppsPanel } from "./AppsPanel.js";

interface Props {
  tv: TvView;
  onClose: () => void;
}

// Browser physical keys -> normalized RemoteKeys (spec §6 step d: "physical arrow-key/enter").
const PHYSICAL_KEYMAP: Record<string, RemoteKey> = {
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  Enter: "OK",
  Backspace: "BACK",
  " ": "PLAY_PAUSE",
};

export function DeviceView({ tv, onClose }: Props): JSX.Element {
  const now = useNow(1000);
  const videoRef = useRef<HTMLVideoElement>(null);
  const physicalSender = useRef<((key: RemoteKey) => void) | null>(null);

  const { status, reserve, release } = useReservation(tv.tv_id);

  // Reserve on open (step a). Only attempt once per mount.
  useEffect(() => {
    void reserve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sessionId = status.phase === "held" ? status.session.session_id : null;

  // WebRTC stream is started only once we hold the lock (step c).
  const stream = useWebrtcStream(sessionId ? tv.tv_id : null, sessionId, videoRef);

  // End session: release the lock; the stream hook tears down stream.unsubscribe + PC on its
  // sessionId going null. (step e)
  const endSession = useCallback(async () => {
    await release();
    onClose();
  }, [release, onClose]);

  // On a lost lock (heartbeat said not_holder/expired) show a banner briefly, then exit.
  useEffect(() => {
    if (status.phase !== "lost") return;
    const id = setTimeout(() => onClose(), 4000);
    return () => clearTimeout(id);
  }, [status.phase, onClose]);

  // Physical keyboard bindings — active only while we hold the lock. Routes through the same
  // lock-validated POST /key path as the on-screen keypad.
  useEffect(() => {
    if (!sessionId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing into an input/select.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const mapped = PHYSICAL_KEYMAP[e.key];
      if (mapped && isRemoteKey(mapped) && physicalSender.current) {
        e.preventDefault();
        physicalSender.current(mapped);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionId]);

  const bindSender = useCallback((send: ((key: RemoteKey) => void) | null) => {
    physicalSender.current = send;
  }, []);

  // ── Render gates ──────────────────────────────────────────────────────────
  if (status.phase === "reserving" || status.phase === "idle") {
    return (
      <Shell title={tv.tv_id} onClose={onClose}>
        <div className="banner info">Reserving the lock…</div>
      </Shell>
    );
  }

  if (status.phase === "conflict") {
    // 409 — someone else holds it. Show "In use by <held_by> until <time>" and do not enter.
    return (
      <Shell title={tv.tv_id} onClose={onClose}>
        <div className="banner warn">
          In use by <strong>{status.conflict.held_by}</strong> until{" "}
          {formatClock(status.conflict.lock_expires_at)} (hard ceiling{" "}
          {formatClock(status.conflict.hard_expires_at)}).
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Back to overview</button>
        </div>
      </Shell>
    );
  }

  if (status.phase === "error") {
    return (
      <Shell title={tv.tv_id} onClose={onClose}>
        <div className="banner error">Could not reserve: {status.message}</div>
        <div className="modal-footer">
          <button onClick={onClose}>Back to overview</button>
        </div>
      </Shell>
    );
  }

  if (status.phase === "released") {
    // Transient — parent will unmount; render nothing meaningful.
    return (
      <Shell title={tv.tv_id} onClose={onClose}>
        <div className="banner info">Session ended.</div>
      </Shell>
    );
  }

  if (status.phase === "lost") {
    // Heartbeat reported the lock is gone (lease lapsed and stolen, or no longer holder). The
    // stream + keypad are already torn down because sessionId went null. Auto-exits shortly.
    return (
      <Shell title={tv.tv_id} onClose={onClose}>
        <div className="banner error">
          Lost the lock ({status.reason === "not_holder" ? "no longer the holder" : "lease lapsed"})
          — the session has ended. Returning to the overview…
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Back to overview</button>
        </div>
      </Shell>
    );
  }

  // status.phase === "held"
  const session = status.session;

  return (
    <Shell title={tv.tv_id} onClose={onClose}>
      {stream.error && (
        <div className="banner error">
          Stream error: {stream.error}
          {(stream.error === "not_holder" ||
            stream.error === "no_binding" ||
            stream.error === "agent_offline") &&
            " — check the binding/agent and retry."}{" "}
          <button onClick={() => stream.restart()} style={{ marginLeft: 8 }}>
            Retry stream
          </button>
        </div>
      )}

      <div className="device-view">
        {/* Live stream pane — the prominent element. */}
        <div className="video-pane">
          <video ref={videoRef} autoPlay playsInline muted />
          {stream.phase !== "connected" && (
            <div className="video-overlay">
              {stream.phase === "subscribing" && "Subscribing to the camera stream…"}
              {stream.phase === "negotiating" && "Negotiating WebRTC… (offer sent)"}
              {stream.phase === "error" && "Stream unavailable."}
              {stream.phase === "idle" && "Starting…"}
            </div>
          )}
        </div>

        {/* Control rail: lock countdowns + soft remote + power. */}
        <div className="control-rail">
          <div className="lock-card">
            <div className="lock-info">
              <div className="lock-row">
                <span className="k">Lease (auto-renews)</span>
                <span className="countdown">{formatCountdown(session.lock_expires_at, now)}</span>
              </div>
              <div className="lock-row">
                <span className="k">Hard ceiling</span>
                <span className="countdown">{formatCountdown(session.hard_expires_at, now)}</span>
              </div>
            </div>
          </div>

          <SoftRemote
            tvId={tv.tv_id}
            sessionId={session.session_id}
            onForbidden={() => void endSession()}
            bindSender={bindSender}
          />

          <PowerControls
            tvId={tv.tv_id}
            sessionId={session.session_id}
            onForbidden={() => void endSession()}
          />

          <button className="danger end-session" onClick={() => void endSession()}>
            End session
          </button>
          <div className="hint" style={{ marginTop: 6 }}>
            Arrow keys / Enter drive the d-pad while this view is focused.
          </div>
        </div>

        {/* Device-management rail: builds + apps (the "other TV options"). */}
        <div className="manage-rail">
          <BuildsPanel
            tvId={tv.tv_id}
            platform={tv.platform}
            sessionId={session.session_id}
          />
          <AppsPanel
            tvId={tv.tv_id}
            sessionId={session.session_id}
            onForbidden={() => void endSession()}
          />
        </div>
      </div>
    </Shell>
  );
}

function Shell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="overlay">
      <div className="modal device-modal">
        <div className="device-modal-head">
          <h3>Device view — {title}</h3>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="device-modal-body">{children}</div>
      </div>
    </div>
  );
}
