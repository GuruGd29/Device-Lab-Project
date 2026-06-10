// Reservation lifecycle for the device view (spec §6 steps 2/5, §7).
//
//   reserve()    -> POST /tvs/:id/reserve. 200 => hold {session_id, expiries}; 409 => conflict
//                   (show "in use by <held_by> until <time>", do NOT enter).
//   heartbeat    -> every 15s POST /tvs/:id/heartbeat {session_id}; renews lock_expires_at.
//                   On !ok (lost lock / stolen) we surface a banner and the caller exits.
//   release()    -> POST /tvs/:id/release {session_id}. Idempotent; also fired on unmount/close.
//
// The hard ceiling (hard_expires_at) is never renewed — the caller shows a separate countdown.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReserveConflict } from "@device-lab/contracts";
import * as api from "../lib/api.js";

const HEARTBEAT_INTERVAL_MS = 15_000; // spec §7: ping ~15–30s.

export interface HeldSession {
  session_id: string;
  lock_expires_at: string;
  hard_expires_at: string;
}

export type ReservationStatus =
  | { phase: "idle" }
  | { phase: "reserving" }
  | { phase: "held"; session: HeldSession }
  | { phase: "conflict"; conflict: ReserveConflict }
  | { phase: "lost"; reason: "not_holder" | "expired" } // heartbeat failed mid-session
  | { phase: "released" }
  | { phase: "error"; message: string };

export function useReservation(tvId: string | null) {
  const [status, setStatus] = useState<ReservationStatus>({ phase: "idle" });
  const sessionRef = useRef<string | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimer.current) {
      clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }
  }, []);

  const release = useCallback(async () => {
    stopHeartbeat();
    const sid = sessionRef.current;
    sessionRef.current = null;
    if (tvId && sid) {
      try {
        await api.release(tvId, sid);
      } catch {
        /* best-effort; the lease will lapse on its own (spec §7) */
      }
    }
    setStatus({ phase: "released" });
  }, [tvId, stopHeartbeat]);

  const reserve = useCallback(async () => {
    if (!tvId) return;
    setStatus({ phase: "reserving" });
    try {
      const res = await api.reserve(tvId);
      if (res.ok) {
        const session: HeldSession = {
          session_id: res.session_id,
          lock_expires_at: res.lock_expires_at,
          hard_expires_at: res.hard_expires_at,
        };
        sessionRef.current = res.session_id;
        setStatus({ phase: "held", session });
      } else {
        // 409 — someone else holds it; do not enter.
        setStatus({ phase: "conflict", conflict: res });
      }
    } catch (err) {
      setStatus({ phase: "error", message: err instanceof Error ? err.message : "reserve failed" });
    }
  }, [tvId]);

  // Heartbeat loop — only while we hold the lock.
  useEffect(() => {
    if (status.phase !== "held") return;
    const sid = status.session.session_id;

    const tick = async () => {
      if (!tvId) return;
      try {
        const hb = await api.reservationHeartbeat(tvId, sid);
        if (hb.ok && hb.lock_expires_at) {
          setStatus((s) =>
            s.phase === "held"
              ? { phase: "held", session: { ...s.session, lock_expires_at: hb.lock_expires_at! } }
              : s,
          );
        } else {
          // Lost the lock (stolen after a lapse, or no longer holder). Exit the view.
          stopHeartbeat();
          sessionRef.current = null;
          setStatus({ phase: "lost", reason: hb.reason ?? "expired" });
        }
      } catch {
        // Network blip — keep trying; the lease has slack before lock_expires_at.
      }
    };

    heartbeatTimer.current = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    return () => stopHeartbeat();
  }, [status.phase, status, tvId, stopHeartbeat]);

  // Safety net: release on unmount / tab close (spec §6 step 5 teardown).
  useEffect(() => {
    const onUnload = () => {
      const sid = sessionRef.current;
      // keepalive fetch survives page unload AND carries the bearer token (sendBeacon can't).
      if (tvId && sid) api.releaseKeepalive(tvId, sid);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      // Component unmount: explicit release (await not possible here, fire-and-forget).
      const sid = sessionRef.current;
      stopHeartbeat();
      if (tvId && sid) {
        sessionRef.current = null;
        void api.release(tvId, sid).catch(() => {});
      }
    };
  }, [tvId, stopHeartbeat]);

  return { status, reserve, release };
}
