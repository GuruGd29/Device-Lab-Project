"""Samsung Tizen control adapter (control_protocol = samsung_ws), via samsungtvws.

The TV was paired once already (spec §1 "Assumed already true"); its token lives at
`control_secret_ref` (a file, or a dir we keep a token file in). We reconnect silently using that
stored token (spec §14) — never re-prompt, never hard-code.

Keys map through SAMSUNG_KEYMAP to KEY_* codes sent over the remote websocket.
render_qr: drive the TV browser to the agent's local calibration page that shows `payload` as a
fullscreen QR (samsungtvws open_browser). clear_qr returns Home.

samsungtvws is synchronous; we run its blocking calls in a thread executor so we never block the
asyncio event loop (which also drives the SFU + cloud tunnel).
"""

from __future__ import annotations

import asyncio
import logging
import os
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
from .keymap import SAMSUNG_KEYMAP

log = logging.getLogger("device_lab_agent.adapter.samsung")


class SamsungAdapter(TvAdapter):
    def __init__(
        self,
        tv_id: str,
        net_ip: str | None,
        control_secret_ref: str | None,
        calibration_base_url: str,
        name: str = "DeviceLabAgent",
        tizen_path: str | None = None,
        sdb_path: str | None = None,
        tizen_target: str | None = None,
    ) -> None:
        super().__init__(tv_id)
        if not net_ip:
            raise ValueError(f"Samsung TV {tv_id} requires net_ip")
        self.net_ip = net_ip
        self.control_secret_ref = control_secret_ref
        # The agent serves a /calibration page off its SFU/HTTP server (sfu.py) rendering the QR.
        self.calibration_base_url = calibration_base_url.rstrip("/")
        self.name = name
        # Tizen install tooling (optional; only needed for build install / app management).
        self.tizen_path = tizen_path
        self.sdb_path = sdb_path
        # Target the tizen/sdb CLI addresses. Default to "<net_ip>:26101" (Tizen sdb default port).
        self.tizen_target = tizen_target or f"{net_ip}:26101"
        self._tv = None  # samsungtvws.async_remote.SamsungTVWSAsyncRemote

    def _token_file(self) -> str | None:
        """Resolve control_secret_ref to a token file path samsungtvws can read/write.
        If the ref is a directory, keep token.txt inside it; if a file, use it directly."""
        if not self.control_secret_ref:
            return None
        p = Path(self.control_secret_ref).expanduser()
        if p.is_dir():
            return str(p / "token.txt")
        return str(p)

    async def connect(self) -> None:
        try:
            # Imported lazily: heavy [hardware] dependency, absent on the DEV_SIMULATE path.
            from samsungtvws.async_remote import SamsungTVWSAsyncRemote  # type: ignore
        except ImportError as exc:  # pragma: no cover - exercised only without [hardware]
            raise TvControlError(
                "samsungtvws not installed; install device-lab-agent[hardware]"
            ) from exc

        token_file = self._token_file()
        if token_file:
            os.makedirs(os.path.dirname(token_file) or ".", exist_ok=True)
        try:
            self._tv = SamsungTVWSAsyncRemote(
                host=self.net_ip,
                port=8002,  # encrypted control port; token persisted to token_file
                name=self.name,
                token_file=token_file,
            )
            await self._tv.start_listening()
            self._reachable = True
            log.info("[samsung %s] control session up (%s)", self.tv_id, self.net_ip)
        except Exception as exc:  # noqa: BLE001 - any vendor/network error => unreachable
            self._reachable = False
            log.warning("[samsung %s] connect failed: %s", self.tv_id, exc)

    async def press(self, key: str) -> None:
        code = SAMSUNG_KEYMAP.get(key)
        if code is None:
            raise KeyNotSupportedError(key)
        if self._tv is None or not self._reachable:
            raise TvControlError("tv_unreachable")
        try:
            await self._tv.send_command_key(code)  # SendRemoteKey under the hood
        except AttributeError:
            # Older samsungtvws exposes send_key.
            try:
                await self._tv.send_key(code)  # type: ignore[attr-defined]
            except Exception as exc:  # noqa: BLE001
                self._reachable = False
                raise TvControlError(str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            self._reachable = False
            raise TvControlError(str(exc)) from exc

    def _calibration_url(self, payload: str) -> str:
        return f"{self.calibration_base_url}/calibration?payload={quote(payload, safe='')}"

    async def render_qr(self, payload: str) -> None:
        """Open the TV browser to the agent's fullscreen-QR calibration page. open_browser is
        synchronous in samsungtvws; run it off-loop."""
        if self._tv is None or not self._reachable:
            raise TvControlError("tv_unreachable")
        url = self._calibration_url(payload)
        try:
            from samsungtvws import SamsungTVWS  # type: ignore

            def _open() -> None:
                rest = SamsungTVWS(host=self.net_ip, port=8002, token_file=self._token_file())
                rest.open_browser(url)

            await asyncio.get_running_loop().run_in_executor(None, _open)
            log.info("[samsung %s] opened calibration browser: %s", self.tv_id, url)
        except Exception as exc:  # noqa: BLE001
            raise TvControlError(f"render_qr failed: {exc}") from exc

    async def clear_qr(self) -> None:
        # Return Home to dismiss the browser overlay. Best-effort: never raise on cleanup.
        try:
            await self.press("HOME")
        except Exception as exc:  # noqa: BLE001
            log.debug("[samsung %s] clear_qr (HOME) failed: %s", self.tv_id, exc)

    async def close(self) -> None:
        self._reachable = False
        if self._tv is not None:
            try:
                await self._tv.close()
            except Exception as exc:  # noqa: BLE001
                log.debug("[samsung %s] close error: %s", self.tv_id, exc)
            self._tv = None

    # ── Build install + app management (Tizen CLI / sdb) ──────────────────────
    async def _sdb_connect(self) -> str:
        """Resolve sdb and `sdb connect <target>` so subsequent `sdb shell`/`sdb install` work.
        Returns the resolved sdb executable. Raises AppActionUnsupportedError when sdb is absent."""
        sdb = resolve_tool(self.sdb_path, "sdb")
        await run_cli([sdb, "connect", self.tizen_target], timeout=30.0, check=False, label="sdb connect")
        return sdb

    async def install_build(
        self,
        local_path: str,
        package_kind: str,
        app_id: str | None,
        progress: ProgressCallback,
    ) -> None:
        if package_kind != "wgt":
            raise AppActionUnsupportedError(
                f"Samsung Tizen installs .wgt, not .{package_kind}"
            )
        await progress("installing", 0.6, "tizen install")
        # Prefer the official Tizen CLI; fall back to sdb install if only sdb is configured.
        if self.tizen_path or resolve_tool_optional("tizen"):
            tizen = resolve_tool(self.tizen_path, "tizen")
            await run_cli(
                [tizen, "install", "-n", local_path, "-t", self.tizen_target],
                timeout=300.0,
                label="tizen install",
            )
        else:
            sdb = await self._sdb_connect()
            await run_cli([sdb, "install", local_path], timeout=300.0, label="sdb install")
        log.info("[samsung %s] installed %s", self.tv_id, local_path)

    async def list_apps(self) -> list[dict]:
        sdb = await self._sdb_connect()
        # `sdb shell 0 applist` (or `vd_appinstall ...`) lists installed Tizen apps with pkg ids.
        res = await run_cli([sdb, "shell", "0", "applist"], timeout=60.0, check=False, label="sdb applist")
        apps: list[dict] = []
        for raw in res.stdout.splitlines():
            line = raw.strip()
            # Lines look like:  'App-ID [com.foo.bar]'  or  'Name 'Foo'  AppID 'com.foo.bar''
            if "[" in line and "]" in line:
                app_id = line[line.index("[") + 1 : line.index("]")].strip()
                name = line[: line.index("[")].strip() or None
                if app_id:
                    apps.append({"app_id": app_id, "name": name, "version": None})
        return apps

    async def launch_app(self, app_id: str) -> None:
        sdb = await self._sdb_connect()
        await run_cli([sdb, "shell", "0", "execute", app_id], timeout=60.0, check=False, label="sdb launch")

    async def uninstall_app(self, app_id: str) -> None:
        # `tizen uninstall -p <pkgid> -t <target>` is the supported path.
        tizen = resolve_tool(self.tizen_path, "tizen")
        await run_cli(
            [tizen, "uninstall", "-p", app_id, "-t", self.tizen_target],
            timeout=120.0,
            label="tizen uninstall",
        )

    async def set_power(self, on: bool) -> None:
        # Samsung exposes a single power toggle over the remote websocket (KEY_POWER). There is no
        # discrete on/off here; toggle it. (Wake-on-LAN would be needed for a true power-on of a
        # fully-off set, which is out of scope of the control session.)
        try:
            await self.press("POWER")
        except KeyNotSupportedError as exc:  # pragma: no cover - POWER is always mapped
            raise AppActionUnsupportedError("POWER not supported") from exc


def resolve_tool_optional(name: str) -> str | None:
    """Like resolve_tool but returns None instead of raising — used to pick tizen vs sdb."""
    import shutil

    return shutil.which(name)
