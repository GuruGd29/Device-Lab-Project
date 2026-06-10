"""Calibration — confirm the camera<->TV binding by QR handshake (spec §5).

Flow on calibrate.start{tv_id, code_payload}:
  1. adapter.render_qr(code_payload)  -> push the tv_id QR onto THIS TV's screen.
  2. Scan every camera's current video frame for a QR/AprilTag whose decoded text == code_payload.
  3. First matching camera => calibration.result{tv_id, matched:true, camera_id, confidence:1.0}.
     Timeout with no match => matched:false.
  4. adapter.clear_qr() always (the cloud also sends calibrate.clear as a backstop).

Decoding tries pyzbar first (fast, robust QR), then OpenCV's QRCodeDetector as a fallback. Both
are [hardware]-extra deps; if neither is importable we degrade to "no decode" (matched:false) and
log a clear hint — except in DEV_SIMULATE where we can decode the synthetic frame numerically.

Frame capture: aiortc tracks yield av.VideoFrame; we pull one recent frame per camera via the
track's recv() (relayed so we don't disturb subscribers).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from aiortc.contrib.media import MediaRelay

from .adapters.base import TvAdapter
from .sfu import Sfu

log = logging.getLogger("device_lab_agent.calibration")


class Calibrator:
    def __init__(self, sfu: Sfu, timeout_seconds: float) -> None:
        self.sfu = sfu
        self.timeout_seconds = timeout_seconds
        # Per-camera relay so scanning doesn't steal frames from active subscribers.
        self._scan_relay = MediaRelay()

    async def run(
        self, tv_id: str, code_payload: str, adapter: TvAdapter
    ) -> dict[str, Any]:
        """Returns the calibration.result dict (built later by the caller). Here we return a
        small result tuple-ish dict: {matched, camera_id?, confidence?}."""
        try:
            await adapter.render_qr(code_payload)
        except NotImplementedError:
            # Android TV without ADB: cannot render a QR. Fall back to manual_confirm (spec §5).
            log.info(
                "[calib %s] platform cannot render QR; manual_confirm fallback required", tv_id
            )
            return {"matched": False}
        except Exception as exc:  # noqa: BLE001
            log.warning("[calib %s] render_qr failed: %s", tv_id, exc)
            return {"matched": False}

        try:
            return await self._scan_until_match(tv_id, code_payload)
        finally:
            try:
                await adapter.clear_qr()
            except Exception as exc:  # noqa: BLE001
                log.debug("[calib %s] clear_qr failed: %s", tv_id, exc)

    async def _scan_until_match(self, tv_id: str, code_payload: str) -> dict[str, Any]:
        deadline = time.time() + self.timeout_seconds
        # Small settle delay so the QR is actually on screen / in the synthetic frame.
        await asyncio.sleep(0.3)
        while time.time() < deadline:
            for camera_id, pub in list(self.sfu.cameras.items()):
                if pub.track is None:
                    continue
                # DEV_SIMULATE: the synthetic camera knows the QR payload it is drawing, so we
                # match on ground truth and never decode pixels. This keeps cv2 OUT of the sim
                # process — on macOS cv2 + PyAV ship clashing libavdevice dylibs that crash.
                if getattr(self.sfu, "dev_simulate", False):
                    if self.sfu.current_sim_payload(camera_id) == code_payload:
                        log.info("[calib %s] MATCH camera=%s payload=%s (sim)", tv_id, camera_id, code_payload)
                        return {"matched": True, "camera_id": camera_id, "confidence": 1.0}
                    continue
                decoded = await self._decode_one_frame(pub)
                if decoded is not None and code_payload in decoded:
                    log.info(
                        "[calib %s] MATCH camera=%s payload=%s", tv_id, camera_id, code_payload
                    )
                    return {"matched": True, "camera_id": camera_id, "confidence": 1.0}
            await asyncio.sleep(0.25)
        log.info("[calib %s] no match within %.0fs", tv_id, self.timeout_seconds)
        return {"matched": False}

    async def _decode_one_frame(self, pub: Any) -> set[str] | None:
        """Pull one frame from the camera track and decode any QR text it contains.
        Returns the set of decoded strings, or None if no frame / no decode available."""
        try:
            relayed = self._scan_relay.subscribe(pub.track)
            frame = await asyncio.wait_for(relayed.recv(), timeout=1.0)
        except Exception as exc:  # noqa: BLE001
            log.debug("frame capture failed for %s: %s", pub.camera_id, exc)
            return None

        try:
            img = frame.to_ndarray(format="bgr24")
        except Exception as exc:  # noqa: BLE001
            log.debug("frame to_ndarray failed: %s", exc)
            return None

        return _decode_qr(img)


def _decode_qr(img: Any) -> set[str] | None:
    """Decode QR codes from a BGR ndarray. pyzbar first, then OpenCV QRCodeDetector.
    Returns a set of decoded strings, or None if no decoder is available."""
    results: set[str] = set()

    # 1. pyzbar (robust, fast). Needs the zbar shared lib (the [hardware] extra).
    try:
        from pyzbar.pyzbar import decode as zbar_decode  # type: ignore

        for sym in zbar_decode(img):
            try:
                results.add(sym.data.decode("utf-8"))
            except Exception:  # noqa: BLE001
                pass
        if results:
            return results
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001
        log.debug("pyzbar decode error: %s", exc)

    # 2. OpenCV fallback.
    try:
        import cv2  # type: ignore

        detector = cv2.QRCodeDetector()
        ok, decoded_info, _, _ = detector.detectAndDecodeMulti(img)
        if ok:
            for txt in decoded_info:
                if txt:
                    results.add(txt)
        else:
            single, _, _ = detector.detectAndDecode(img)
            if single:
                results.add(single)
        return results if results else set()
    except ImportError:
        # Neither decoder available — only possible outside the [hardware] extra. Signal "no
        # decode" so callers report matched:false with a clear log hint.
        log.warning(
            "no QR decoder available (install device-lab-agent[hardware] for pyzbar/opencv)"
        )
        return None
    except Exception as exc:  # noqa: BLE001
        log.debug("opencv decode error: %s", exc)
        return results or None
