"""TvAdapter ABC — the contract every per-platform control adapter implements.

The agent talks to TVs ONLY through this interface. A normalized RemoteKey goes in; the adapter
translates to the vendor protocol (samsung_ws / lg_ssap / androidtv_remote) and presses it.
render_qr/clear_qr drive the calibration handshake (spec §5): the agent pushes the tv_id payload
onto the TV's own screen so a camera can see it.

Reachability (`reachable`) feeds the TvStatus the agent heartbeats up — a TV whose control
session is down reports `offline`, otherwise the per-device status from the runtime.
"""

from __future__ import annotations

import abc
from typing import Awaitable, Callable, Optional

# Async progress callback the installer hands to install_build. Signature:
#   progress(status: str, fraction: float, message: str | None) -> Awaitable[None]
# `status` is an InstallStatus value (builds.ts) — typically "installing"; `fraction` is 0..1.
ProgressCallback = Callable[[str, float, Optional[str]], Awaitable[None]]


class KeyNotSupportedError(Exception):
    """Raised when a normalized RemoteKey has no mapping for this platform.
    Surfaces as key.ack{ok:false, error:"unsupported_key"} (api.ts KeyPressResponse reason)."""


class TvControlError(Exception):
    """Raised when the vendor control channel fails (TV unreachable, session lost, etc.).
    Surfaces as key.ack{ok:false, error:"tv_unreachable"}."""


class AppActionUnsupportedError(Exception):
    """Raised when an app action (install/launch/list/uninstall/power) cannot be performed on
    this platform — e.g. the required vendor CLI (adb / tizen / sdb / ares-*) is not configured.
    Surfaces to the cloud as the "unsupported" reason in TvActionResponse (api.ts)."""


class TvAdapter(abc.ABC):
    """Common interface for Samsung / LG / Android TV / simulator adapters."""

    def __init__(self, tv_id: str) -> None:
        self.tv_id = tv_id
        self._reachable = False

    @property
    def reachable(self) -> bool:
        """Whether the persistent vendor control session is currently usable. Drives the
        per-TV status the agent reports in heartbeats."""
        return self._reachable

    @abc.abstractmethod
    async def connect(self) -> None:
        """Open (or refresh) the persistent vendor control session. Idempotent: safe to call
        on tv.connect repeatedly. Should set `reachable` based on success. Must not raise on a
        transient failure during normal operation — log and leave `reachable=False` instead."""

    @abc.abstractmethod
    async def press(self, key: str) -> None:
        """Send one normalized RemoteKey to the TV. `key` is one of REMOTE_KEYS.
        Raise KeyNotSupportedError for an unmapped key, TvControlError if the channel fails."""

    @abc.abstractmethod
    async def render_qr(self, payload: str) -> None:
        """Render `payload` (== tv_id) fullscreen on THIS TV's screen so a camera can see it.
        Best-effort per platform (Android TV cannot natively, see androidtv.py)."""

    @abc.abstractmethod
    async def clear_qr(self) -> None:
        """Dismiss the calibration QR / return the TV to its prior state. Always called after a
        calibration attempt (the cloud also sends calibrate.clear as a backstop)."""

    @abc.abstractmethod
    async def close(self) -> None:
        """Tear down the control session cleanly (tv.disconnect / shutdown)."""

    # ── Build install + app management ("other TV options") ───────────────────
    # Drive the per-platform package installer + app lifecycle. Raise AppActionUnsupportedError
    # when the required vendor CLI isn't configured (the cloud surfaces "unsupported"); raise
    # TvControlError when the tool is present but fails / the TV is unreachable.

    @abc.abstractmethod
    async def install_build(
        self,
        local_path: str,
        package_kind: str,
        app_id: str | None,
        progress: ProgressCallback,
    ) -> None:
        """Install the package at `local_path` (already downloaded by the installer) onto this TV.
        `package_kind` is one of "apk"/"wgt"/"ipk"; `app_id` is the best-effort package id.
        Emit at least one progress(status="installing", fraction, message) partway through, then
        return on success (the installer marks the job "installed"). Raise on failure."""

    @abc.abstractmethod
    async def list_apps(self) -> list[dict]:
        """Return installed apps as a list of AppInfo-shaped dicts:
        [{app_id, name?, version?, running?}]. Raise on an unreachable/unsupported TV."""

    @abc.abstractmethod
    async def launch_app(self, app_id: str) -> None:
        """Launch the app identified by `app_id`. Raise on failure."""

    @abc.abstractmethod
    async def uninstall_app(self, app_id: str) -> None:
        """Uninstall the app identified by `app_id`. Raise on failure."""

    @abc.abstractmethod
    async def set_power(self, on: bool) -> None:
        """Power the TV on (`on=True`) or off (`on=False`). Raise on failure."""
