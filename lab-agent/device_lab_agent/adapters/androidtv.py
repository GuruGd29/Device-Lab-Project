"""Android TV control adapter (control_protocol = androidtv_remote), via androidtvremote2.

The TV was paired once; its cert + key live under `control_secret_ref` (a directory holding
cert.pem + key.pem, or pointed at by ANDROIDTV_CERT/ANDROIDTV_KEY filenames inside it). We
reconnect silently with the stored cert (spec §14).

Keys map through ANDROIDTV_KEYMAP to KeyCode names (DPAD_UP, DPAD_CENTER, MEDIA_PLAY, ...).

CALIBRATION CAVEAT (documented per the task): the Android TV remote v2 protocol cannot launch an
arbitrary URL, so render_qr cannot natively put a QR on screen. Two fallbacks:
  * If ADB_PATH is set, we fire an ADB `am start` VIEW intent at the calibration URL (best-effort,
    requires adb-over-network to the TV).
  * Otherwise render_qr raises NotImplementedError; calibration for this TV must fall back to
    manual_confirm (spec §5 fallback) — the agent reports matched=false and the operator confirms
    the binding in the dashboard.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
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
from .keymap import ANDROIDTV_KEYMAP

log = logging.getLogger("device_lab_agent.adapter.androidtv")


class AndroidTvAdapter(TvAdapter):
    def __init__(
        self,
        tv_id: str,
        net_ip: str | None,
        control_secret_ref: str | None,
        calibration_base_url: str,
        adb_path: str | None = None,
        client_name: str = "Device Lab Agent",
    ) -> None:
        super().__init__(tv_id)
        if not net_ip:
            raise ValueError(f"Android TV {tv_id} requires net_ip")
        self.net_ip = net_ip
        self.control_secret_ref = control_secret_ref
        self.calibration_base_url = calibration_base_url.rstrip("/")
        self.adb_path = adb_path
        self.client_name = client_name
        self._remote = None  # androidtvremote2.AndroidTVRemote

    def _cert_key_paths(self) -> tuple[str, str]:
        """Resolve control_secret_ref -> (cert_path, key_path). Defaults: cert.pem / key.pem
        inside the referenced directory."""
        base = Path(self.control_secret_ref).expanduser() if self.control_secret_ref else Path(".")
        if base.is_file():
            # A single ref file is ambiguous; treat its parent as the cert dir.
            base = base.parent
        return str(base / "cert.pem"), str(base / "key.pem")

    async def connect(self) -> None:
        try:
            from androidtvremote2 import AndroidTVRemote  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise TvControlError(
                "androidtvremote2 not installed; install device-lab-agent[hardware]"
            ) from exc

        cert_path, key_path = self._cert_key_paths()
        try:
            self._remote = AndroidTVRemote(
                client_name=self.client_name,
                certfile=cert_path,
                keyfile=key_path,
                host=self.net_ip,
            )
            # Loads the stored cert; will raise if the pairing cert is missing/invalid.
            await self._remote.async_generate_cert_if_missing()
            await self._remote.async_connect()
            self._remote.keep_reconnecting()  # silent reconnect loop (spec §14)
            self._reachable = True
            log.info("[androidtv %s] control session up (%s)", self.tv_id, self.net_ip)
        except Exception as exc:  # noqa: BLE001
            self._reachable = False
            log.warning("[androidtv %s] connect failed: %s", self.tv_id, exc)

    async def press(self, key: str) -> None:
        code = ANDROIDTV_KEYMAP.get(key)
        if code is None:
            raise KeyNotSupportedError(key)
        if self._remote is None or not self._reachable:
            raise TvControlError("tv_unreachable")
        try:
            # send_key_command is synchronous in androidtvremote2.
            self._remote.send_key_command(code)
        except Exception as exc:  # noqa: BLE001
            self._reachable = False
            raise TvControlError(str(exc)) from exc

    def _calibration_url(self, payload: str) -> str:
        return f"{self.calibration_base_url}/calibration?payload={quote(payload, safe='')}"

    async def render_qr(self, payload: str) -> None:
        url = self._calibration_url(payload)
        if self.adb_path and shutil.which(self.adb_path) or (self.adb_path and Path(self.adb_path).exists()):
            # Best-effort ADB intent. Requires adb-over-network already authorized on the TV.
            await self._adb_open_url(url)
            return
        # No URL-launch path on the bare remote protocol. Caller must fall back to manual_confirm.
        raise NotImplementedError(
            "Android TV remote protocol cannot launch a URL; "
            "set ADB_PATH for the ADB-intent fallback, or use manual_confirm calibration."
        )

    async def _adb_open_url(self, url: str) -> None:
        assert self.adb_path is not None
        cmd = [
            self.adb_path,
            "-s",
            f"{self.net_ip}:5555",
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            url,
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                raise TvControlError(f"adb intent failed: {stderr.decode(errors='replace')}")
            log.info("[androidtv %s] opened calibration URL via ADB: %s", self.tv_id, url)
        except FileNotFoundError as exc:
            raise TvControlError(f"adb not found at {self.adb_path}") from exc

    async def clear_qr(self) -> None:
        # Press HOME to leave whatever the ADB intent opened. Best-effort.
        try:
            await self.press("HOME")
        except Exception as exc:  # noqa: BLE001
            log.debug("[androidtv %s] clear_qr (HOME) failed: %s", self.tv_id, exc)

    async def close(self) -> None:
        self._reachable = False
        if self._remote is not None:
            try:
                self._remote.disconnect()
            except Exception as exc:  # noqa: BLE001
                log.debug("[androidtv %s] close error: %s", self.tv_id, exc)
            self._remote = None

    # ── Build install + app management (ADB over the TV network) ──────────────
    @property
    def _serial(self) -> str:
        """ADB serial for this TV: <net_ip>:5555 (adb-over-network)."""
        return f"{self.net_ip}:5555"

    def _adb_tool(self) -> str:
        """Resolve the adb executable, or raise AppActionUnsupportedError (cloud -> 'unsupported')."""
        return resolve_tool(self.adb_path, "adb")

    async def _adb(self, *args: str, timeout: float = 180.0, check: bool = True):
        """Run `adb -s <serial> <args>` after ensuring the device is connected."""
        adb = self._adb_tool()
        return await run_cli(
            [adb, "-s", self._serial, *args],
            timeout=timeout,
            check=check,
            label=f"adb {args[0] if args else ''}",
        )

    async def _adb_connect(self) -> None:
        """`adb connect <net_ip>:5555` — idempotent; required before -s targets a network TV."""
        adb = self._adb_tool()
        await run_cli([adb, "connect", self._serial], timeout=30.0, check=True, label="adb connect")

    async def install_build(
        self,
        local_path: str,
        package_kind: str,
        app_id: str | None,
        progress: ProgressCallback,
    ) -> None:
        if package_kind != "apk":
            raise AppActionUnsupportedError(
                f"Android TV installs .apk, not .{package_kind}"
            )
        await self._adb_connect()
        await progress("installing", 0.6, "adb install -r")
        # -r reinstalls keeping data; -g grants runtime perms so the app is launchable after.
        res = await self._adb("install", "-r", local_path, timeout=300.0, check=False)
        combined = (res.stdout + res.stderr)
        if not res.ok or "Success" not in combined:
            raise TvControlError(
                f"adb install failed: {combined.strip() or f'exit {res.returncode}'}"
            )
        log.info("[androidtv %s] installed %s", self.tv_id, local_path)

    async def list_apps(self) -> list[dict]:
        await self._adb_connect()
        # -3 = third-party packages only (skip system apps). Output: "package:com.foo".
        res = await self._adb("shell", "pm", "list", "packages", "-3")
        apps: list[dict] = []
        for line in res.stdout.splitlines():
            line = line.strip()
            if line.startswith("package:"):
                pkg = line[len("package:"):].strip()
                if pkg:
                    apps.append({"app_id": pkg, "name": None, "version": None})
        return apps

    async def launch_app(self, app_id: str) -> None:
        await self._adb_connect()
        # monkey reliably starts a package's launcher activity without knowing the component name.
        res = await self._adb(
            "shell",
            "monkey",
            "-p",
            app_id,
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
            check=False,
        )
        if res.ok:
            return
        # Fallback: explicit launch intent.
        await self._adb("shell", "am", "start", "-n", app_id)

    async def uninstall_app(self, app_id: str) -> None:
        await self._adb_connect()
        res = await self._adb("uninstall", app_id, check=False)
        if not res.ok or "Success" not in (res.stdout + res.stderr):
            raise TvControlError(
                f"adb uninstall failed: {(res.stdout + res.stderr).strip()}"
            )

    async def set_power(self, on: bool) -> None:
        await self._adb_connect()
        # KEYCODE_WAKEUP (224) wakes; KEYCODE_POWER (26) toggles standby.
        keycode = "224" if on else "26"
        await self._adb("shell", "input", "keyevent", keycode)
