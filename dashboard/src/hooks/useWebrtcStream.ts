// WebRTC receive-only stream for the device view (spec §6 step 3). The dashboard is a pure
// consumer: it creates an offer, sends it up the dashboard WS as signal.offer, and the agent's
// SFU answers via signal.answer + trickled signal.candidate (relayed by the cloud). Media rides
// the LOCAL link (phone → SFU → browser) — the cloud only relays this JSON signaling.
//
// Flow:
//   1. WS stream.subscribe {tv_id, session_id}  (cloud validates we're the lock holder)
//   2. RTCPeerConnection + addTransceiver('video', recvonly)
//   3. createOffer -> setLocalDescription -> WS signal.offer {tv_id, payload: offer}
//   4. inbound signal.answer -> setRemoteDescription; signal.candidate -> addIceCandidate
//   5. ontrack -> attach to <video>; apply aggressive jitter buffer (playoutDelayHint ~30ms)
//   6. teardown: WS stream.unsubscribe {tv_id} + close the peer connection
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CloudToDashboard,
  DashboardError,
} from "@device-lab/contracts";
import { dashboardSocket } from "../lib/ws.js";

export type StreamPhase =
  | "idle"
  | "subscribing"
  | "negotiating"
  | "connected"
  | "error";

export interface StreamState {
  phase: StreamPhase;
  /** Set when the cloud rejects the stream/signaling (DashboardError.reason). */
  error: DashboardError["reason"] | "webrtc_failed" | null;
}

// Public STUN keeps host-candidate gathering robust; the lab/SFU path is local-network so a
// TURN relay isn't required for Phase 1. The agent's SFU answer drives the actual transport.
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export function useWebrtcStream(
  tvId: string | null,
  sessionId: string | null,
  videoRef: React.RefObject<HTMLVideoElement>,
): StreamState & { restart: () => void } {
  const [state, setState] = useState<StreamState>({ phase: "idle", error: null });
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [generation, setGeneration] = useState(0);

  const teardownPeer = useCallback(() => {
    const pc = pcRef.current;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      pcRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [videoRef]);

  const restart = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    if (!tvId || !sessionId) {
      setState({ phase: "idle", error: null });
      return;
    }

    let cancelled = false;
    setState({ phase: "subscribing", error: null });

    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;

    // Receive-only video transceiver — we never publish.
    pc.addTransceiver("video", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      const [stream] = ev.streams;
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
      }
      // Aggressive jitter buffer for low glass-to-glass latency (spec §6 step 3, ~30–40ms).
      // playoutDelayHint is Chromium-specific; jitterBufferTarget is the standardized successor.
      // Both are best-effort and guarded behind feature checks.
      try {
        const receiver = ev.receiver as RTCRtpReceiver & {
          playoutDelayHint?: number;
          jitterBufferTarget?: number;
        };
        if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = 0.03;
        if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 30; // ms
      } catch {
        /* receiver tuning is best-effort */
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        // Trickle our local ICE candidates up to the agent via the cloud relay.
        dashboardSocket.send({
          type: "signal.candidate",
          tv_id: tvId,
          payload: ev.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (cancelled) return;
      const st = pc.connectionState;
      if (st === "connected") {
        setState({ phase: "connected", error: null });
      } else if (st === "failed" || st === "closed") {
        setState({ phase: "error", error: "webrtc_failed" });
      }
    };

    // Inbound signaling for THIS tv. The cloud only delivers signal.* for the TV we subscribed.
    const offSignal = dashboardSocket.onMessage((msg: CloudToDashboard) => {
      if (cancelled) return;
      void handleInbound(msg);
    });

    async function handleInbound(msg: CloudToDashboard): Promise<void> {
      if (msg.type === "error" && (msg.scope === "stream" || msg.scope === "signaling")) {
        if (!msg.tv_id || msg.tv_id === tvId) {
          setState({ phase: "error", error: msg.reason });
        }
        return;
      }
      if (msg.type === "signal.answer" && msg.tv_id === tvId) {
        try {
          await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
          setState((s) => (s.phase === "error" ? s : { phase: "negotiating", error: null }));
        } catch {
          setState({ phase: "error", error: "webrtc_failed" });
        }
        return;
      }
      if (msg.type === "signal.candidate" && msg.tv_id === tvId) {
        try {
          await pc.addIceCandidate(msg.payload as RTCIceCandidateInit);
        } catch {
          /* a late/duplicate candidate is non-fatal */
        }
        return;
      }
    }

    async function negotiate(): Promise<void> {
      // 1. Tell the cloud we want this TV's stream (lock-holder validated server-side).
      dashboardSocket.send({ type: "stream.subscribe", tv_id: tvId!, session_id: sessionId! });
      // 2/3. Offer.
      try {
        const offer = await pc.createOffer({ offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        if (cancelled) return;
        setState({ phase: "negotiating", error: null });
        dashboardSocket.send({
          type: "signal.offer",
          tv_id: tvId!,
          payload: pc.localDescription ?? offer,
        });
      } catch {
        setState({ phase: "error", error: "webrtc_failed" });
      }
    }

    void negotiate();

    return () => {
      cancelled = true;
      offSignal();
      // Tell the cloud to stop the stream, then close the peer connection (spec §6 step 5).
      dashboardSocket.send({ type: "stream.unsubscribe", tv_id: tvId });
      teardownPeer();
    };
    // generation drives an explicit retry; tvId/sessionId drive (re)subscription.
  }, [tvId, sessionId, generation, videoRef, teardownPeer]);

  return { ...state, restart };
}
