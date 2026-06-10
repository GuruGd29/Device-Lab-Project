"""LG webOS control adapter (control_protocol = lg_ssap), via aiowebostv.

The TV was paired once; its client-key lives at `control_secret_ref` (a file holding the key, or
a dir we keep client_key.txt in). We reconnect silently with that key (spec §14).

Directional / OK / BACK / HOME / MENU ride the webOS "input socket" pointer-button channel;
transport, volume, channel and power go over SSAP request URIs. LG_KEYMAP tags each entry so we
know which path to take (see adapters/keymap.py).

render_qr launches the webOS browser app pointed at the agent's calibration page (which shows the
payload as a fullscreen QR).
"""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import quote

from .base import (
    AppActionUnsupportedError,
    KeyNotSupportedError,
    ProgressCallback,
    TvAdapter,
    TvControlError,
)
from .cli import resolve_tool, run_cli
from .keymap import LG_KEYMAP

log = logging.getLogger("device_lab_agent.adapter.lg")

# webOS browser app id; launching it with a `target` opens that URL fullscreen.
_BROWSER_APP_ID = "com.webos.app.browser"


class LgAdapter(TvAdapter):
    def __init__(
        self,
        tv_id: str,
        net_ip: str | None,
        control_secret_ref: str | None,
        calibration_base_url: str,
        ares_path: str | None = None,
        ares_device: str | None = None,
    ) -> None:
        super().__init__(tv_id)
        if not net_ip:
            raise ValueError(f"LG TV {tv_id} requires net_ip")
        self.net_ip = net_ip
        self.control_secret_ref = control_secret_ref
        self.calibration_base_url = calibration_base_url.rstrip("/")
        # ares CLI tooling for build install / app management (optional).
        # ares_path points at `ares-install` (the other ares-* tools sit beside it).
        self.ares_path = ares_path
        self.ares_device = ares_device  # `-d <name>` device alias from `ares-setup-device`.
        self._client = None  # aiowebostv.WebOsClient
        self._input_connected = False

    def _read_client_key(self) -> str | None:
        """Resolve control_secret_ref -> the stored webOS client-key string."""
        if not self.control_secret_ref:
            return None
        p = Path(self.control_secret_ref).expanduser()
        if p.is_dir():
            p = p / "client_key.txt"
        if p.is_file():
            return p.read_text(encoding="utf-8").strip() or None
        return None

    async def connect(self) -> None:
        try:
            from aiowebostv import WebOsClient  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise TvControlError(
                "aiowebostv not installed; install device-lab-agent[hardware]"
            ) from exc

        key = self._read_client_key()
        try:
            self._client = WebOsClient(self.net_ip, client_key=key)
            await self._client.connect()
            self._reachable = True
            log.info("[lg %s] control session up (%s)", self.tv_id, self.net_ip)
        except Exception as exc:  # noqa: BLE001
            self._reachable = False
            log.warning("[lg %s] connect failed: %s", self.tv_id, exc)

    async def _ensure_input(self) -> None:
        """Open the pointer/input socket once, lazily — needed for button() presses."""
        if self._input_connected or self._client is None:
            return
        try:
            await self._client.input_button_connect()  # type: ignore[attr-defined]
            self._input_connected = True
        except Exception as exc:  # noqa: BLE001
            log.debug("[lg %s] input socket connect failed: %s", self.tv_id, exc)

    async def press(self, key: str) -> None:
        spec = LG_KEYMAP.get(key)
        if spec is None:
            raise KeyNotSupportedError(key)
        if self._client is None or not self._reachable:
            raise TvControlError("tv_unreachable")
        try:
            if spec[0] == "button":
                await self._ensure_input()
                await self._client.button(spec[1])  # type: ignore[attr-defined]
            else:  # ("request", uri, payload)
                _, uri, payload = spec
                await self._client.request(uri, payload=payload or None)  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001
            self._reachable = False
            raise TvControlError(str(exc)) from exc

    def _calibration_url(self, payload: str) -> str:
        return f"{self.calibration_base_url}/calibration?payload={quote(payload, safe='')}"

    async def render_qr(self, payload: str) -> None:
        if self._client is None or not self._reachable:
            raise TvControlError("tv_unreachable")
        url = self._calibration_url(payload)
        try:
            # Launch the browser app aimed at the calibration page (fullscreen QR).
            await self._client.launch_app_with_params(  # type: ignore[attr-defined]
                _BROWSER_APP_ID, {"target": url}
            )
            log.info("[lg %s] launched calibration browser: %s", self.tv_id, url)
        except AttributeError:
            # Fallback for client versions exposing open_browser / request directly.
            try:
                await self._client.request(  # type: ignore[attr-defined]
                    "ssap://system.launcher/open", payload={"target": url}
                )
                log.info("[lg %s] launched calibration via launcher: %s", self.tv_id, url)
            except Exception as exc:  # noqa: BLE001
                raise TvControlError(f"render_qr failed: {exc}") from exc
        except Exception as exc:  # noqa: BLE001
            raise TvControlError(f"render_qr failed: {exc}") from exc

    async def clear_qr(self) -> None:
        # Close the browser app to dismiss the QR. Best-effort.
        if self._client is None:
            return
        try:
            await self._client.request(  # type: ignore[attr-defined]
                "ssap://system.launcher/close", payload={"id": _BROWSER_APP_ID}
            )
        except Exception as exc:  # noqa: BLE001
            log.debug("[lg %s] clear_qr failed: %s", self.tv_id, exc)

    async def close(self) -> None:
        self._reachable = False
        self._input_connected = False
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception as exc:  # noqa: BLE001
                log.debug("[lg %s] close error: %s", self.tv_id, exc)
            self._client = None

    # ── Build install + app management (ares-* CLI) ───────────────────────────
    def _ares_tool(self, name: str) -> str:
        """Resolve an ares-* executable. `ares_path` (if set) points at ares-install; sibling
        tools live in the same directory. Falls back to PATH. Raises AppActionUnsupportedError
        when the tool can't be found (cloud surfaces 'unsupported')."""
        if self.ares_path:
            base = Path(self.ares_path).expanduser()
            sibling = base.parent / name if base.parent != Path("") else Path(name)
            if name == "ares-install":
                return resolve_tool(str(base), name)
            return resolve_tool(str(sibling), name)
        return resolve_tool(None, name)

    def _device_args(self) -> list[str]:
        """`-d <alias>` selects the configured ares device, when one is set."""
        return ["-d", self.ares_device] if self.ares_device else []

    async def install_build(
        self,
        local_path: str,
        package_kind: str,
        app_id: str | None,
        progress: ProgressCallback,
    ) -> None:
        if package_kind != "ipk":
            raise AppActionUnsupportedError(
                f"LG webOS installs .ipk, not .{package_kind}"
            )
        ares_install = self._ares_tool("ares-install")
        await progress("installing", 0.6, "ares-install")
        await run_cli(
            [ares_install, *self._device_args(), local_path],
            timeout=300.0,
            label="ares-install",
        )
        log.info("[lg %s] installed %s", self.tv_id, local_path)

    async def list_apps(self) -> list[dict]:
        ares_install = self._ares_tool("ares-install")
        # `ares-install --list` prints installed app ids, one per line.
        res = await run_cli(
            [ares_install, *self._device_args(), "--list"],
            timeout=60.0,
            label="ares-install --list",
        )
        apps: list[dict] = []
        for raw in res.stdout.splitlines():
            line = raw.strip()
            if not line or line.lower().startswith(("installed", "no ", "----")):
                continue
            # The first whitespace-delimited token is the app id.
            app_id = line.split()[0]
            apps.append({"app_id": app_id, "name": None, "version": None})
        return apps

    async def launch_app(self, app_id: str) -> None:
        ares_launch = self._ares_tool("ares-launch")
        await run_cli(
            [ares_launch, *self._device_args(), app_id],
            timeout=60.0,
            label="ares-launch",
        )

    async def uninstall_app(self, app_id: str) -> None:
        ares_install = self._ares_tool("ares-install")
        await run_cli(
            [ares_install, *self._device_args(), "-r", app_id],
            timeout=120.0,
            label="ares-install -r",
        )

    async def set_power(self, on: bool) -> None:
        # webOS has no remote power-ON over SSAP once the set is off; we expose the supported
        # turnOff (POWER key -> ssap://system/turnOff). Power-on would require Wake-on-LAN.
        if on:
            raise AppActionUnsupportedError(
                "webOS cannot be powered on over the control session (needs Wake-on-LAN)"
            )
        try:
            await self.press("POWER")  # -> ssap://system/turnOff
        except KeyNotSupportedError as exc:  # pragma: no cover
            raise AppActionUnsupportedError("POWER not supported") from exc
