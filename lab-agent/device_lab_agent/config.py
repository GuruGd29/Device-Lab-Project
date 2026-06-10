"""Configuration loading for the Lab Controller Agent.

Two sources, both deliberately separate (spec §3, §14):
  * Environment — connection/identity/secrets (CLOUD_WS_URL, AGENT_ID, AGENT_SHARED_SECRET,
    SFU_SIGNALING_URL, DEV_SIMULATE). Secrets are NEVER baked into the device inventory.
  * devices.yaml — the static physical inventory this box owns (the TVs on its subnet and the
    cameras mounted at them). Each TV references its stored token/key/cert via
    `control_secret_ref` — a pointer, never the secret inline (spec §14).

The cloud OWNS the registry (spec §3 placement rule); this file only describes what hardware
this agent presents on connect via agent.register_devices.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(slots=True)
class TvConfig:
    """One TV this agent controls. Mirrors the ReportedTv contract fields plus the
    bits the agent needs locally (mac/vlan/control_secret_ref). Field names match
    packages/contracts/src/agent-protocol.ts ReportedTv exactly."""

    tv_id: str
    platform: str  # "tizen" | "webos" | "androidtv"
    control_protocol: str  # "samsung_ws" | "lg_ssap" | "androidtv_remote"
    net_ip: str | None = None
    mac: str | None = None
    vlan: str | None = None
    slot_id: str | None = None
    rack_position: str | None = None
    # Pointer to stored token/client-key/cert dir or file — resolved by the adapter, never inline.
    control_secret_ref: str | None = None
    firmware_version: str | None = None
    serial: str | None = None

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "TvConfig":
        required = ("tv_id", "platform", "control_protocol")
        missing = [k for k in required if not d.get(k)]
        if missing:
            raise ValueError(f"TV entry missing required keys {missing}: {d!r}")
        return TvConfig(
            tv_id=str(d["tv_id"]),
            platform=str(d["platform"]),
            control_protocol=str(d["control_protocol"]),
            net_ip=_opt_str(d.get("net_ip")),
            mac=_opt_str(d.get("mac")),
            vlan=_opt_str(d.get("vlan")),
            slot_id=_opt_str(d.get("slot_id")),
            rack_position=_opt_str(d.get("rack_position")),
            control_secret_ref=_opt_str(d.get("control_secret_ref")),
            firmware_version=_opt_str(d.get("firmware_version")),
            serial=_opt_str(d.get("serial")),
        )


@dataclass(slots=True)
class CameraConfig:
    """One mounted capture phone. The agent assigns/holds its SFU publish track id at runtime;
    here we only know its identity and which rack slot it sits in."""

    camera_id: str
    slot_id: str | None = None

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "CameraConfig":
        if not d.get("camera_id"):
            raise ValueError(f"camera entry missing camera_id: {d!r}")
        return CameraConfig(
            camera_id=str(d["camera_id"]),
            slot_id=_opt_str(d.get("slot_id")),
        )


@dataclass(slots=True)
class Config:
    # --- Cloud tunnel / identity ---
    cloud_ws_url: str
    agent_id: str
    agent_shared_secret: str
    version: str
    hostname: str

    # --- Local SFU media plane ---
    sfu_signaling_url: str  # advertised to the cloud; dashboards reach the SFU here
    sfu_bind_host: str
    sfu_bind_port: int

    # --- Behaviour ---
    dev_simulate: bool
    calibration_timeout_seconds: float
    reconnect_min_seconds: float
    reconnect_max_seconds: float
    adb_path: str | None  # optional: enables Android TV URL-launch calibration via ADB intent + install
    ares_path: str | None  # optional: LG webOS ares-* CLI (ares-install/ares-launch). Default "ares-install".
    tizen_path: str | None  # optional: Samsung Tizen CLI (`tizen install`/`tizen uninstall`).
    sdb_path: str | None  # optional: Samsung Smart Development Bridge (`sdb install`/`sdb shell`).
    ares_device: str | None  # optional: ares device alias (`-d <name>`) the LG CLIs target.
    tizen_target: str | None  # optional: tizen/sdb target serial (`-t <serial>`) for Samsung installs.

    # --- Inventory ---
    tvs: list[TvConfig] = field(default_factory=list)
    cameras: list[CameraConfig] = field(default_factory=list)


def _opt_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _parse_sfu_url(url: str) -> tuple[str, int]:
    """Derive (bind_host, bind_port) from an advertised SFU signaling URL like
    http://0.0.0.0:7000. The agent binds its aiohttp server to host:port; the same URL
    (with the host the dashboard can reach) is reported up to the cloud in agent.hello."""
    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = parsed.hostname or "0.0.0.0"
    port = parsed.port or 7000
    return host, port


def load_devices(path: Path) -> tuple[list[TvConfig], list[CameraConfig]]:
    """Parse devices.yaml. In DEV_SIMULATE mode a missing file is fine — callers fall back
    to built-in fake devices so the dev path needs zero setup."""
    if not path.exists():
        return [], []
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} must be a YAML mapping with 'tvs' and 'cameras' keys")
    tvs = [TvConfig.from_dict(t) for t in (data.get("tvs") or [])]
    cameras = [CameraConfig.from_dict(c) for c in (data.get("cameras") or [])]
    return tvs, cameras


def _default_simulated_inventory() -> tuple[list[TvConfig], list[CameraConfig]]:
    """Two fake TVs (a Samsung + an LG) each with a bound camera, so DEV_SIMULATE works with
    zero config. Matches the acceptance criterion: register a couple of fake TVs + cameras."""
    tvs = [
        TvConfig(
            tv_id="tv-sim-samsung-01",
            platform="tizen",
            control_protocol="samsung_ws",
            net_ip="10.0.0.11",
            mac="aa:bb:cc:00:00:11",
            vlan="tv-subnet",
            slot_id="rack-A/pos-01",
            rack_position="rack-A/pos-01",
            firmware_version="sim-1.0",
            serial="SIM-SAMSUNG-01",
        ),
        TvConfig(
            tv_id="tv-sim-lg-02",
            platform="webos",
            control_protocol="lg_ssap",
            net_ip="10.0.0.12",
            mac="aa:bb:cc:00:00:12",
            vlan="tv-subnet",
            slot_id="rack-A/pos-02",
            rack_position="rack-A/pos-02",
            firmware_version="sim-1.0",
            serial="SIM-LG-02",
        ),
    ]
    cameras = [
        CameraConfig(camera_id="cam-sim-01", slot_id="rack-A/pos-01"),
        CameraConfig(camera_id="cam-sim-02", slot_id="rack-A/pos-02"),
    ]
    return tvs, cameras


def load_config() -> Config:
    """Build the full Config from env + devices.yaml. Env wins for connection/secrets."""
    dev_simulate = _env_bool("DEV_SIMULATE", False)

    sfu_signaling_url = os.environ.get("SFU_SIGNALING_URL", "http://0.0.0.0:7000")
    bind_host, bind_port = _parse_sfu_url(sfu_signaling_url)

    devices_path = Path(
        os.environ.get(
            "DEVICES_YAML",
            str(Path(__file__).resolve().parent.parent / "devices.yaml"),
        )
    )
    tvs, cameras = load_devices(devices_path)

    if not tvs and not cameras and dev_simulate:
        # Zero-config dev path: synthesize a believable inventory.
        tvs, cameras = _default_simulated_inventory()

    return Config(
        cloud_ws_url=os.environ.get("CLOUD_WS_URL", "ws://localhost:8080/agent"),
        agent_id=os.environ.get("AGENT_ID", "lab-agent-01"),
        agent_shared_secret=os.environ.get("AGENT_SHARED_SECRET", "dev-agent-secret"),
        version=os.environ.get("AGENT_VERSION", "0.1.0"),
        hostname=os.environ.get("AGENT_HOSTNAME", socket.gethostname()),
        sfu_signaling_url=sfu_signaling_url,
        sfu_bind_host=bind_host,
        sfu_bind_port=bind_port,
        dev_simulate=dev_simulate,
        calibration_timeout_seconds=float(os.environ.get("CALIBRATION_TIMEOUT_SECONDS", "20")),
        reconnect_min_seconds=float(os.environ.get("RECONNECT_MIN_SECONDS", "1")),
        reconnect_max_seconds=float(os.environ.get("RECONNECT_MAX_SECONDS", "30")),
        adb_path=_opt_str(os.environ.get("ADB_PATH")),
        ares_path=_opt_str(os.environ.get("ARES_PATH")),
        tizen_path=_opt_str(os.environ.get("TIZEN_PATH")),
        sdb_path=_opt_str(os.environ.get("SDB_PATH")),
        ares_device=_opt_str(os.environ.get("ARES_DEVICE")),
        tizen_target=_opt_str(os.environ.get("TIZEN_TARGET")),
        tvs=tvs,
        cameras=cameras,
    )
