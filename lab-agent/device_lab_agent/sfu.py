"""Local media plane (SFU) — aiortc + aiohttp. Media stays LOCAL (spec §3); only signaling
JSON ever rides the cloud tunnel.

Three responsibilities:

1. INGEST (WHIP-style): the Android capture phone POSTs an SDP offer to /whip/{camera_id}; we
   answer and stash the inbound video track per camera_id. That track id is the camera's
   `sfu_publish_track` reported up in heartbeats. POST /camera/{camera_id}/heartbeat lets the
   phone report liveness. DELETE /whip/{camera_id} stops publishing.

2. SUBSCRIBE: when the cloud sends stream.request{tv_id,camera_id,dashboard_session} and then
   relays the dashboard's signal.offer, we create an RTCPeerConnection, addTrack the stored
   camera track (via MediaRelay so it can fan out / re-subscribe), answer, and send signal.answer
   back up the tunnel with the SAME dashboard_session. ICE candidates relay both ways.
   stream.teardown closes that pc.

3. DEV_SIMULATE: with no real phone, synthesize a per-camera VideoStreamTrack drawing the
   camera_id + a moving timestamp. When that camera's bound TV is "rendering" a calibration QR
   (SimAdapter.qr_payload set), the frame draws a REAL decodable QR for the payload so the
   calibration scan genuinely matches end-to-end with no hardware.

The calibration page (GET /calibration?payload=...) renders the payload as a fullscreen QR for
real TVs whose browser the vendor adapter points here.
"""

from __future__ import annotations

import asyncio
import fractions
import logging
import time
from typing import Any, Callable

from aiohttp import web
from aiortc import (
    RTCConfiguration,
    RTCIceCandidate,
    RTCPeerConnection,
    RTCSessionDescription,
    VideoStreamTrack,
)
from aiortc.contrib.media import MediaRelay
from aiortc.sdp import candidate_from_sdp, candidate_to_sdp
from av import VideoFrame
import numpy as np

log = logging.getLogger("device_lab_agent.sfu")

# Signal callback: (tv_id, dashboard_session, kind, payload) -> coroutine sending up the tunnel.
SignalSender = Callable[[str, str, str, Any], "asyncio.Future | Any"]

VIDEO_W, VIDEO_H = 640, 480
VIDEO_CLOCK_RATE = 90000  # standard 90kHz video clock for RTP timestamps


class SimCameraTrack(VideoStreamTrack):
    """Synthetic camera feed. Draws the camera_id + a moving clock. If a `qr_provider` callback
    returns a payload string (the bound TV is rendering a calibration QR), draws a real,
    pyzbar/OpenCV-decodable QR for it so calibration succeeds in DEV_SIMULATE."""

    def __init__(self, camera_id: str, qr_provider: Callable[[], str | None]) -> None:
        super().__init__()
        self.camera_id = camera_id
        self._qr_provider = qr_provider
        self._start = time.time()

    async def recv(self) -> VideoFrame:
        pts, time_base = await self._next_timestamp()
        img = self._render()
        frame = VideoFrame.from_ndarray(img, format="bgr24")
        frame.pts = pts
        frame.time_base = time_base
        return frame

    async def _next_timestamp(self) -> tuple[int, fractions.Fraction]:
        # ~15fps; pace the loop so we don't spin the CPU on a dev box.
        if hasattr(self, "_timestamp"):
            self._timestamp += int((1 / 15) * VIDEO_CLOCK_RATE)
            wait = self._start + (self._timestamp / VIDEO_CLOCK_RATE) - time.time()
            if wait > 0:
                await asyncio.sleep(wait)
        else:
            self._start = time.time()
            self._timestamp = 0
        return self._timestamp, fractions.Fraction(1, VIDEO_CLOCK_RATE)

    def _render(self) -> "np.ndarray":
        payload = self._qr_provider()
        if payload:
            # White background so the QR's quiet zone is satisfied and cv2/pyzbar decode it.
            img = np.full((VIDEO_H, VIDEO_W, 3), 255, dtype=np.uint8)
            qr = _make_qr_bgr(payload, size=min(VIDEO_W, VIDEO_H) - 80)
            if qr is not None:
                qh, qw = qr.shape[:2]
                y0 = (VIDEO_H - qh) // 2
                x0 = (VIDEO_W - qw) // 2
                img[y0 : y0 + qh, x0 : x0 + qw] = qr
            _draw_text(img, self.camera_id, 10, 24, color=(20, 20, 20))
            return img
        # Idle feed: dark slate with an identifying caption + moving clock.
        img = np.zeros((VIDEO_H, VIDEO_W, 3), dtype=np.uint8)
        img[:] = (32, 32, 48)  # BGR
        _draw_text(img, self.camera_id, 10, 24)
        _draw_text(img, f"t={time.time() - self._start:6.1f}s", 10, VIDEO_H - 16)
        return img


_QR_QUIET_MODULES = 4  # quiet-zone width in modules; cv2/pyzbar need it to lock on


def _make_qr_bgr(payload: str, size: int) -> "np.ndarray | None":
    """Render `payload` to a square BGR ndarray QR with a proper white quiet zone. Uses segno
    (pure-Python, a core dep). Returns None only if no encoder is available."""
    modules = _qr_matrix(payload)
    if modules is None:
        return None
    n = modules.shape[0]
    total = n + 2 * _QR_QUIET_MODULES
    scale = max(2, size // total)
    # dark module -> black (0), light/quiet -> white (255)
    canvas = np.full((total, total), 255, dtype=np.uint8)
    canvas[
        _QR_QUIET_MODULES : _QR_QUIET_MODULES + n,
        _QR_QUIET_MODULES : _QR_QUIET_MODULES + n,
    ] = np.where(modules == 1, 0, 255).astype(np.uint8)
    big = np.kron(canvas, np.ones((scale, scale), dtype=np.uint8))
    return np.repeat(big[:, :, None], 3, axis=2)


def _qr_matrix(payload: str) -> "np.ndarray | None":
    """Build a QR module matrix (1=dark). segno (core dep) first, qrcode as a fallback.

    We pin a MINIMUM version of 2 (25x25 modules). cv2.QRCodeDetector — the decoder on the
    light DEV_SIMULATE path — reliably reads version>=2 QRs but routinely FAILS on version-1
    (21x21 / 17x17) codes regardless of pixel scale. Pinning version>=2 makes the synthetic
    calibration QR decodable for any tv_id payload (verified for 1..32-char payloads). segno
    auto-bumps to a higher version when the payload needs more capacity."""
    try:
        import segno  # type: ignore

        try:
            q = segno.make(payload, error="m", version=2)
        except Exception:  # noqa: BLE001 — payload too big for v2; let segno pick the fit
            q = segno.make(payload, error="m")
        rows = [[1 if c else 0 for c in row] for row in q.matrix]
        return np.array(rows, dtype=np.uint8)
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001
        log.debug("segno encode failed: %s", exc)
    try:
        import qrcode  # type: ignore

        qr = qrcode.QRCode(version=2, border=0, box_size=1)
        qr.add_data(payload)
        qr.make(fit=True)
        return np.array(qr.get_matrix(), dtype=np.uint8)
    except Exception:  # noqa: BLE001
        return None


def _draw_text(img: "np.ndarray", text: str, x: int, y: int, color: tuple = (240, 240, 240)) -> None:
    """cv2-FREE liveness/identity marker. We deliberately avoid importing OpenCV in the sim
    render path: in DEV_SIMULATE this runs in the same process as PyAV (aiortc), and on macOS
    cv2 and av ship duplicate libavdevice dylibs whose ObjC classes clash and cause intermittent
    native crashes. The on-frame text was only cosmetic — the dashboard labels the camera/TV — so
    we paint a deterministic color band keyed by `text` (stable per camera; flickers for the live
    clock, conveying liveness). Real cameras show real video; this only affects the synthetic feed."""
    h, w = img.shape[:2]
    band_h = 16
    y0 = max(0, min(h - band_h, y - 13))
    x1 = min(w, x + 190)
    hsh = abs(hash(text))
    c = (30 + hsh % 200, 30 + (hsh // 211) % 200, 30 + (hsh // 47000) % 200)  # BGR
    img[y0 : y0 + band_h, x:x1] = c


class CameraPublication:
    """A published camera: its ingest peer connection (real phone) or synthetic track (sim),
    the live MediaStreamTrack, and a MediaRelay so multiple dashboards (and re-subscribes) work."""

    def __init__(self, camera_id: str) -> None:
        self.camera_id = camera_id
        self.track: Any = None  # MediaStreamTrack (video)
        self.relay = MediaRelay()
        self.ingest_pc: RTCPeerConnection | None = None
        self.last_heartbeat: float = 0.0
        self.publish_track_id: str | None = None  # the sfu_publish_track reported to the cloud

    def relayed(self) -> Any:
        """A fresh relayed handle to the track — safe to addTrack onto many subscriber pcs."""
        return self.relay.subscribe(self.track)


class Sfu:
    def __init__(
        self,
        bind_host: str,
        bind_port: int,
        dev_simulate: bool,
        signal_sender: SignalSender,
        qr_provider: Callable[[str], str | None],
        ice_servers: list | None = None,
    ) -> None:
        """qr_provider(camera_id) -> the calibration payload currently shown on that camera's
        bound TV (sim only), used to draw the QR in the synthetic feed."""
        self.bind_host = bind_host
        self.bind_port = bind_port
        self.dev_simulate = dev_simulate
        self._signal_sender = signal_sender
        self._qr_provider = qr_provider
        self._rtc_config = RTCConfiguration(iceServers=ice_servers or [])

        self.cameras: dict[str, CameraPublication] = {}
        # subscriber pcs keyed by (tv_id, dashboard_session) so teardown is precise.
        self._subscribers: dict[tuple[str, str], RTCPeerConnection] = {}
        # (tv_id, dashboard_session) -> camera_id, set on stream.request, read when the offer
        # arrives so handle_offer knows which camera track to serve.
        self._pending_subscriptions: dict[tuple[str, str], str] = {}

        self._app = web.Application()
        self._runner: web.AppRunner | None = None
        self._setup_routes()

    # ── HTTP routes ───────────────────────────────────────────────────────────
    def _setup_routes(self) -> None:
        self._app.router.add_post("/whip/{camera_id}", self._handle_whip_ingest)
        # WHIP trickle ICE: the capture phone PATCHes candidate(s) as an SDP fragment to the
        # resource it got back in the POST's Location header (draft-ietf-wish-whip §4.1).
        self._app.router.add_route("PATCH", "/whip/{camera_id}", self._handle_whip_trickle)
        self._app.router.add_delete("/whip/{camera_id}", self._handle_whip_stop)
        self._app.router.add_post("/camera/{camera_id}/heartbeat", self._handle_cam_heartbeat)
        self._app.router.add_get("/calibration", self._handle_calibration_page)
        self._app.router.add_get("/healthz", self._handle_health)

    async def start(self) -> None:
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.bind_host, self.bind_port)
        await site.start()
        log.info("SFU listening on %s:%d (dev_simulate=%s)", self.bind_host, self.bind_port, self.dev_simulate)

    async def stop(self) -> None:
        for key in list(self._subscribers):
            await self._close_subscriber(*key)
        for cam in list(self.cameras.values()):
            if cam.ingest_pc is not None:
                await cam.ingest_pc.close()
        if self._runner is not None:
            await self._runner.cleanup()

    # ── Sim camera bootstrap ────────────────────────────────────────────────
    def ensure_sim_camera(self, camera_id: str) -> None:
        """Create a synthetic publication for a camera (DEV_SIMULATE). Idempotent."""
        if camera_id in self.cameras:
            return
        pub = CameraPublication(camera_id)
        pub.track = SimCameraTrack(camera_id, lambda cid=camera_id: self._qr_provider(cid))
        pub.publish_track_id = f"sim-track-{camera_id}"
        pub.last_heartbeat = time.time()
        self.cameras[camera_id] = pub
        log.info("sim camera ready: %s (track=%s)", camera_id, pub.publish_track_id)

    def camera_status(self, camera_id: str, offline_after: float) -> str:
        """Map publication liveness -> CameraStatus enum value. In sim the synthetic feed is
        always online; for real phones we require a recent heartbeat."""
        pub = self.cameras.get(camera_id)
        if pub is None or pub.track is None:
            return "offline"
        if self.dev_simulate:
            return "online"
        if time.time() - pub.last_heartbeat > offline_after:
            return "offline"
        return "online"

    def publish_track_id(self, camera_id: str) -> str | None:
        pub = self.cameras.get(camera_id)
        return pub.publish_track_id if pub else None

    def current_sim_payload(self, camera_id: str) -> str | None:
        """DEV_SIMULATE only: the payload the synthetic camera is currently drawing as a QR
        (set when its bound TV renders a calibration code). Lets calibration match by ground
        truth instead of decoding pixels — which keeps cv2 out of the sim process entirely
        (see _draw_text for why that matters on macOS)."""
        pub = self.cameras.get(camera_id)
        provider = getattr(pub.track if pub else None, "_qr_provider", None)
        if provider is None:
            return None
        try:
            return provider()
        except Exception:  # noqa: BLE001
            return None

    # ── INGEST (WHIP) ─────────────────────────────────────────────────────────
    async def _handle_whip_ingest(self, request: web.Request) -> web.Response:
        camera_id = request.match_info["camera_id"]
        body = await request.text()
        try:
            offer = RTCSessionDescription(sdp=body, type="offer")
        except Exception:  # noqa: BLE001
            return web.Response(status=400, text="invalid SDP offer")

        pub = self.cameras.get(camera_id)
        if pub is None:
            pub = CameraPublication(camera_id)
            self.cameras[camera_id] = pub
        # Replace any prior ingest pc for this camera (phone reconnected).
        if pub.ingest_pc is not None:
            await pub.ingest_pc.close()

        pc = RTCPeerConnection(configuration=self._rtc_config)
        pub.ingest_pc = pc

        @pc.on("track")
        def _on_track(track: Any) -> None:  # noqa: ANN001
            if track.kind == "video":
                pub.track = track
                pub.publish_track_id = f"whip-{camera_id}-{track.id}"
                pub.last_heartbeat = time.time()
                log.info("camera %s publishing video track %s", camera_id, pub.publish_track_id)

            @track.on("ended")
            async def _on_ended() -> None:
                log.info("camera %s track ended", camera_id)
                if pub.track is track:
                    pub.track = None
                    pub.publish_track_id = None

        await pc.setRemoteDescription(offer)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        # WHIP returns the answer SDP with 201 Created.
        return web.Response(
            status=201,
            content_type="application/sdp",
            headers={"Location": f"/whip/{camera_id}"},
            text=pc.localDescription.sdp,
        )

    async def _handle_whip_trickle(self, request: web.Request) -> web.Response:
        camera_id = request.match_info["camera_id"]
        pub = self.cameras.get(camera_id)
        if pub is None or pub.ingest_pc is None:
            return web.Response(status=404, text="no ingest session")
        body = await request.text()
        added = 0
        for cand in _ice_candidates_from_sdpfrag(body):
            try:
                await pub.ingest_pc.addIceCandidate(cand)
                added += 1
            except Exception as exc:  # noqa: BLE001
                log.debug("camera %s trickle add failed: %s", camera_id, exc)
        log.debug("camera %s trickled %d ICE candidate(s)", camera_id, added)
        return web.Response(status=204)

    async def _handle_whip_stop(self, request: web.Request) -> web.Response:
        camera_id = request.match_info["camera_id"]
        pub = self.cameras.get(camera_id)
        if pub and pub.ingest_pc is not None:
            await pub.ingest_pc.close()
            pub.ingest_pc = None
            pub.track = None
            pub.publish_track_id = None
            log.info("camera %s ingest stopped", camera_id)
        return web.Response(status=200)

    async def _handle_cam_heartbeat(self, request: web.Request) -> web.Response:
        camera_id = request.match_info["camera_id"]
        pub = self.cameras.get(camera_id)
        if pub is None:
            return web.Response(status=404, text="unknown camera")
        pub.last_heartbeat = time.time()
        return web.json_response({"ok": True})

    async def _handle_health(self, _request: web.Request) -> web.Response:
        return web.json_response(
            {"ok": True, "cameras": list(self.cameras.keys()), "subscribers": len(self._subscribers)}
        )

    # ── Calibration page (real TVs point their browser here) ──────────────────
    async def _handle_calibration_page(self, request: web.Request) -> web.Response:
        payload = request.query.get("payload", "")
        html = _CALIBRATION_HTML.replace("__PAYLOAD__", _html_escape(payload))
        return web.Response(content_type="text/html", text=html)

    # ── SUBSCRIBE (dashboard offers; agent answers with the camera track) ─────
    async def request_stream(self, tv_id: str, camera_id: str, dashboard_session: str) -> None:
        """Ensure the camera track exists/ready before the dashboard's offer arrives. In sim we
        spin up the synthetic feed lazily here if it wasn't pre-created."""
        if self.dev_simulate:
            self.ensure_sim_camera(camera_id)
        pub = self.cameras.get(camera_id)
        if pub is None or pub.track is None:
            log.warning("stream.request for %s/%s: no live camera track yet", tv_id, camera_id)
        # The actual pc is created when the offer arrives (handle_offer). Remember the mapping so
        # the offer can find which camera to serve.
        self._pending_subscriptions[(tv_id, dashboard_session)] = camera_id

    async def handle_offer(self, tv_id: str, dashboard_session: str, payload: Any) -> None:
        """Dashboard is the offerer/receiver. Create a pc, addTrack the relayed camera track,
        set remote offer, answer, and send signal.answer back up with the same session."""
        camera_id = self._pending_subscriptions.get((tv_id, dashboard_session))
        if camera_id is None:
            log.warning("offer for %s/%s with no prior stream.request — ignoring", tv_id, dashboard_session)
            return
        pub = self.cameras.get(camera_id)
        if pub is None or pub.track is None:
            log.warning("offer for %s/%s but camera %s has no track", tv_id, dashboard_session, camera_id)
            return

        # Tear down any existing subscriber pc for this (tv, session) before re-offering.
        await self._close_subscriber(tv_id, dashboard_session)

        pc = RTCPeerConnection(configuration=self._rtc_config)
        self._subscribers[(tv_id, dashboard_session)] = pc

        @pc.on("icecandidate")
        async def _on_ice(candidate: Any) -> None:  # noqa: ANN001
            if candidate is None:
                return
            await self._signal_sender(
                tv_id, dashboard_session, "signal.candidate", _ice_to_payload(candidate)
            )

        @pc.on("connectionstatechange")
        async def _on_state() -> None:
            log.debug("subscriber %s/%s state=%s", tv_id, dashboard_session, pc.connectionState)
            if pc.connectionState in ("failed", "closed"):
                await self._close_subscriber(tv_id, dashboard_session)

        # Add the camera's video track (relayed so multiple subscribers / re-subscribes work).
        pc.addTrack(pub.relayed())

        offer_sdp = _sdp_from_payload(payload, "offer")
        await pc.setRemoteDescription(offer_sdp)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await self._signal_sender(
            tv_id,
            dashboard_session,
            "signal.answer",
            {"type": pc.localDescription.type, "sdp": pc.localDescription.sdp},
        )
        log.info("answered subscribe %s/%s serving camera %s", tv_id, dashboard_session, camera_id)

    async def handle_candidate(self, tv_id: str, dashboard_session: str, payload: Any) -> None:
        """Add a remote ICE candidate from the dashboard to the matching subscriber pc."""
        pc = self._subscribers.get((tv_id, dashboard_session))
        if pc is None:
            return
        candidate = _ice_from_payload(payload)
        if candidate is not None:
            await pc.addIceCandidate(candidate)

    async def teardown_stream(self, tv_id: str, dashboard_session: str) -> None:
        self._pending_subscriptions.pop((tv_id, dashboard_session), None)
        await self._close_subscriber(tv_id, dashboard_session)

    async def _close_subscriber(self, tv_id: str, dashboard_session: str) -> None:
        pc = self._subscribers.pop((tv_id, dashboard_session), None)
        if pc is not None:
            try:
                await pc.close()
            except Exception as exc:  # noqa: BLE001
                log.debug("subscriber close error %s/%s: %s", tv_id, dashboard_session, exc)


# ── SDP / ICE payload helpers ────────────────────────────────────────────────


def _sdp_from_payload(payload: Any, default_type: str) -> RTCSessionDescription:
    if isinstance(payload, dict):
        return RTCSessionDescription(sdp=payload.get("sdp", ""), type=payload.get("type", default_type))
    return RTCSessionDescription(sdp=str(payload), type=default_type)


def _ice_to_payload(candidate: RTCIceCandidate) -> dict[str, Any]:
    """Serialize an aiortc candidate to the browser-friendly RTCIceCandidateInit shape."""
    return {
        "candidate": "candidate:" + candidate_to_sdp(candidate),
        "sdpMid": candidate.sdpMid,
        "sdpMLineIndex": candidate.sdpMLineIndex,
    }


def _ice_from_payload(payload: Any) -> RTCIceCandidate | None:
    """Parse a browser RTCIceCandidateInit into an aiortc RTCIceCandidate."""
    if not isinstance(payload, dict):
        return None
    cand_str = payload.get("candidate")
    if not cand_str:
        return None
    # Strip the leading "candidate:" the browser includes.
    sdp = cand_str.split(":", 1)[1] if cand_str.startswith("candidate:") else cand_str
    try:
        candidate = candidate_from_sdp(sdp)
    except Exception:  # noqa: BLE001
        return None
    candidate.sdpMid = payload.get("sdpMid")
    candidate.sdpMLineIndex = payload.get("sdpMLineIndex")
    return candidate


def _ice_candidates_from_sdpfrag(text: str) -> list[RTCIceCandidate]:
    """Parse a WHIP trickle-ICE SDP fragment (m-line context + a=candidate lines) into aiortc
    candidates, carrying sdpMid/sdpMLineIndex from the surrounding m=/a=mid lines."""
    out: list[RTCIceCandidate] = []
    mid: str | None = None
    mline_index = -1
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("m="):
            mline_index += 1
        elif line.startswith("a=mid:"):
            mid = line[len("a=mid:") :]
        elif line.startswith("a=candidate:"):
            try:
                cand = candidate_from_sdp(line[len("a=candidate:") :])
            except Exception:  # noqa: BLE001
                continue
            cand.sdpMid = mid
            cand.sdpMLineIndex = mline_index if mline_index >= 0 else 0
            out.append(cand)
    return out


def _html_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# Fullscreen-QR calibration page. Real TVs (Samsung/LG) point their browser here; we render the
# tv_id payload as a big QR client-side via a CDN qrcode lib (the lab has local network; if the
# TV browser is offline-only, replace this with a server-rendered PNG).
_CALIBRATION_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>Device Lab Calibration</title>
<style>html,body{margin:0;height:100%;background:#101018;display:flex;align-items:center;
justify-content:center}#qr{background:#fff;padding:24px;border-radius:8px}
#p{position:fixed;top:8px;left:8px;color:#888;font:14px monospace}</style>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script></head>
<body><div id="qr"></div><div id="p">__PAYLOAD__</div>
<script>new QRCode(document.getElementById('qr'),
{text:"__PAYLOAD__",width:480,height:480,correctLevel:QRCode.CorrectLevel.M});</script>
</body></html>"""
