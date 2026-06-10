"""SimAdapter — the DEV_SIMULATE TV adapter (no hardware).

Logs key presses and "renders" the calibration QR by flipping a shared flag that the simulated
camera feed reads (sfu.py draws the actual QR for the rendering TV's bound camera). This is what
makes calibration succeed end-to-end on a dev machine with zero hardware: the agent renders a
"QR" -> the synthetic camera frame draws it -> the QR scanner decodes it -> matched=true.

Reachability is always True in sim so the TV reports `free`/`no_camera` rather than `offline`.
"""

from __future__ import annotations

import asyncio
import logging
import os

from .base import KeyNotSupportedError, ProgressCallback, TvAdapter
from .keymap import is_remote_key

log = logging.getLogger("device_lab_agent.adapter.sim")

# A couple of believable preinstalled apps so list-apps is non-empty before any install.
_PREINSTALLED: tuple[dict, ...] = (
    {"app_id": "com.netflix.ninja", "name": "Netflix", "version": "9.1.0"},
    {"app_id": "com.youtube.tv", "name": "YouTube", "version": "4.2.7"},
)


class SimAdapter(TvAdapter):
    def __init__(self, tv_id: str) -> None:
        super().__init__(tv_id)
        # The payload currently "displayed" on this TV, or None. The simulated camera bound to
        # this TV reads this each frame and draws a real, decodable QR for it.
        self.qr_payload: str | None = None
        # In-memory app state for the DEV_SIMULATE demo. Keyed by app_id -> AppInfo dict. Seeded
        # with the preinstalled set; install_build adds to it so list/launch/uninstall reflect it.
        self._apps: dict[str, dict] = {a["app_id"]: dict(a) for a in _PREINSTALLED}
        self._power_on = True

    async def connect(self) -> None:
        self._reachable = True
        log.info("[sim %s] control session up", self.tv_id)

    async def press(self, key: str) -> None:
        if not is_remote_key(key):
            raise KeyNotSupportedError(key)
        log.info("[sim %s] key press: %s", self.tv_id, key)

    async def render_qr(self, payload: str) -> None:
        self.qr_payload = payload
        log.info("[sim %s] rendering calibration QR payload=%s", self.tv_id, payload)

    async def clear_qr(self) -> None:
        if self.qr_payload is not None:
            log.info("[sim %s] clearing calibration QR", self.tv_id)
        self.qr_payload = None

    async def close(self) -> None:
        self._reachable = False
        self.qr_payload = None
        log.info("[sim %s] control session closed", self.tv_id)

    # ── Build install + app management (in-memory, no hardware) ───────────────
    @staticmethod
    def _derive_app_id(local_path: str, app_id: str | None) -> str:
        """Use the explicit app_id when given, else derive one from the build filename so the
        installed app shows up in list_apps with a believable id."""
        if app_id:
            return app_id
        stem = os.path.splitext(os.path.basename(local_path))[0] or "app"
        # Keep it id-ish: strip whitespace, lower, prefix a fake vendor namespace.
        slug = "".join(ch if ch.isalnum() else "." for ch in stem.strip().lower()).strip(".")
        return f"com.demo.{slug or 'app'}"

    async def install_build(
        self,
        local_path: str,
        package_kind: str,
        app_id: str | None,
        progress: ProgressCallback,
    ) -> None:
        resolved = self._derive_app_id(local_path, app_id)
        log.info("[sim %s] install_build kind=%s app_id=%s path=%s", self.tv_id, package_kind, resolved, local_path)
        # Emit an "installing" tick partway through, then briefly "work".
        await progress("installing", 0.6, f"installing {resolved}")
        await asyncio.sleep(0.4)
        # Add (or refresh) the app so list/launch/uninstall see it this session.
        self._apps[resolved] = {
            "app_id": resolved,
            "name": resolved.rsplit(".", 1)[-1].title(),
            "version": "1.0.0",
            "running": False,
        }
        log.info("[sim %s] installed %s", self.tv_id, resolved)

    async def list_apps(self) -> list[dict]:
        # Return copies so callers can't mutate internal state.
        return [dict(a) for a in self._apps.values()]

    async def launch_app(self, app_id: str) -> None:
        if app_id not in self._apps:
            # Be lenient in sim: launching an unknown id just registers + runs it.
            self._apps[app_id] = {"app_id": app_id, "name": None, "version": None, "running": False}
        for aid, info in self._apps.items():
            info["running"] = aid == app_id
        log.info("[sim %s] launch_app %s", self.tv_id, app_id)

    async def uninstall_app(self, app_id: str) -> None:
        self._apps.pop(app_id, None)
        log.info("[sim %s] uninstall_app %s", self.tv_id, app_id)

    async def set_power(self, on: bool) -> None:
        self._power_on = on
        log.info("[sim %s] set_power on=%s", self.tv_id, on)
