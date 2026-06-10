"""Wire protocol for the Agent <-> Cloud control tunnel.

Builders + parsers that mirror packages/contracts/src/agent-protocol.ts EXACTLY. Every frame is
plain JSON; media never travels this channel (spec §3). The cloud's agentHub.ts switches on the
`type` discriminator, so these builders only ever emit the exact keys the cloud reads.

AgentToCloud (this agent emits):
    agent.hello, agent.register_devices, agent.heartbeat, calibration.result, key.ack,
    signal.answer, signal.candidate, install.progress, app.list.result, app.ack
CloudToAgent (this agent receives):
    agent.welcome, calibrate.start, calibrate.clear, key.press, stream.request,
    stream.teardown, signal.offer, signal.candidate, tv.connect, tv.disconnect,
    install.build, app.launch, app.list, app.uninstall, tv.power

Optional: validate inbound frames against schemas/agent-protocol.schema.json (the CloudToAgent
branch) when jsonschema + the schema file are present. Validation is best-effort and never
blocks operation — an unrecognized-but-well-formed frame is simply ignored by the dispatcher.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# ── Inbound (CloudToAgent) message type constants ────────────────────────────
AGENT_WELCOME = "agent.welcome"
CALIBRATE_START = "calibrate.start"
CALIBRATE_CLEAR = "calibrate.clear"
KEY_PRESS = "key.press"
STREAM_REQUEST = "stream.request"
STREAM_TEARDOWN = "stream.teardown"
SIGNAL_OFFER = "signal.offer"
SIGNAL_CANDIDATE_IN = "signal.candidate"
TV_CONNECT = "tv.connect"
TV_DISCONNECT = "tv.disconnect"
INSTALL_BUILD = "install.build"
APP_LAUNCH = "app.launch"
APP_LIST = "app.list"
APP_UNINSTALL = "app.uninstall"
TV_POWER = "tv.power"

# ── Outbound (AgentToCloud) message type constants ───────────────────────────
AGENT_HELLO = "agent.hello"
AGENT_REGISTER_DEVICES = "agent.register_devices"
AGENT_HEARTBEAT = "agent.heartbeat"
CALIBRATION_RESULT = "calibration.result"
KEY_ACK = "key.ack"
SIGNAL_ANSWER = "signal.answer"
SIGNAL_CANDIDATE_OUT = "signal.candidate"
INSTALL_PROGRESS = "install.progress"
APP_LIST_RESULT = "app.list.result"
APP_ACK = "app.ack"

# ── Install status values (mirrors InstallStatus in builds.ts) ────────────────
INSTALL_STATUSES: tuple[str, ...] = (
    "queued",
    "downloading",
    "installing",
    "installed",
    "failed",
)


# ── Outbound builders (AgentToCloud) ─────────────────────────────────────────
# Each returns a dict ready for json.dumps. Keys match the contract interfaces 1:1; we omit
# optional keys when None so the emitted frame is minimal and validates cleanly.


def agent_hello(
    agent_id: str,
    shared_secret: str,
    *,
    sfu_signaling_url: str,
    version: str,
    hostname: str | None = None,
) -> dict[str, Any]:
    host: dict[str, Any] = {"sfu_signaling_url": sfu_signaling_url, "version": version}
    if hostname:
        host["hostname"] = hostname
    return {
        "type": AGENT_HELLO,
        "agent_id": agent_id,
        "shared_secret": shared_secret,
        "host": host,
    }


def reported_tv(
    *,
    tv_id: str,
    platform: str,
    control_protocol: str,
    status: str,
    serial: str | None = None,
    firmware_version: str | None = None,
    net_ip: str | None = None,
    mac: str | None = None,
    vlan: str | None = None,
    slot_id: str | None = None,
    rack_position: str | None = None,
    control_secret_ref: str | None = None,
) -> dict[str, Any]:
    """Build one ReportedTv entry. Required: tv_id, platform, control_protocol, status."""
    out: dict[str, Any] = {
        "tv_id": tv_id,
        "platform": platform,
        "control_protocol": control_protocol,
        "status": status,
    }
    optionals = {
        "serial": serial,
        "firmware_version": firmware_version,
        "net_ip": net_ip,
        "mac": mac,
        "vlan": vlan,
        "slot_id": slot_id,
        "rack_position": rack_position,
        "control_secret_ref": control_secret_ref,
    }
    for k, v in optionals.items():
        if v is not None:
            out[k] = v
    return out


def reported_camera(
    *,
    camera_id: str,
    status: str,
    slot_id: str | None = None,
    sfu_publish_track: str | None = None,
) -> dict[str, Any]:
    """Build one ReportedCamera entry. Required: camera_id, status."""
    out: dict[str, Any] = {"camera_id": camera_id, "status": status}
    if slot_id is not None:
        out["slot_id"] = slot_id
    if sfu_publish_track is not None:
        out["sfu_publish_track"] = sfu_publish_track
    return out


def agent_register_devices(
    agent_id: str, tvs: list[dict[str, Any]], cameras: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "type": AGENT_REGISTER_DEVICES,
        "agent_id": agent_id,
        "tvs": tvs,
        "cameras": cameras,
    }


def agent_heartbeat(
    agent_id: str,
    tvs: list[dict[str, Any]],
    cameras: list[dict[str, Any]],
) -> dict[str, Any]:
    """tvs: [{tv_id, status}], cameras: [{camera_id, status, sfu_publish_track?, slot_id?}].
    The cloud's applyHeartbeat reads exactly those fields."""
    return {
        "type": AGENT_HEARTBEAT,
        "agent_id": agent_id,
        "tvs": tvs,
        "cameras": cameras,
    }


def heartbeat_tv(tv_id: str, status: str) -> dict[str, Any]:
    return {"tv_id": tv_id, "status": status}


def heartbeat_camera(
    camera_id: str,
    status: str,
    sfu_publish_track: str | None = None,
    slot_id: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"camera_id": camera_id, "status": status}
    if sfu_publish_track is not None:
        out["sfu_publish_track"] = sfu_publish_track
    if slot_id is not None:
        out["slot_id"] = slot_id
    return out


def calibration_result(
    tv_id: str,
    matched: bool,
    camera_id: str | None = None,
    confidence: float | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"type": CALIBRATION_RESULT, "tv_id": tv_id, "matched": matched}
    if camera_id is not None:
        out["camera_id"] = camera_id
    if confidence is not None:
        out["confidence"] = confidence
    return out


def key_ack(
    request_id: str, tv_id: str, ok: bool, error: str | None = None
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "type": KEY_ACK,
        "request_id": request_id,
        "tv_id": tv_id,
        "ok": ok,
    }
    if error is not None:
        out["error"] = error
    return out


def signal_answer(
    tv_id: str, dashboard_session: str, payload: Any
) -> dict[str, Any]:
    return {
        "type": SIGNAL_ANSWER,
        "tv_id": tv_id,
        "dashboard_session": dashboard_session,
        "payload": payload,
    }


def signal_candidate(
    tv_id: str, dashboard_session: str, payload: Any
) -> dict[str, Any]:
    return {
        "type": SIGNAL_CANDIDATE_OUT,
        "tv_id": tv_id,
        "dashboard_session": dashboard_session,
        "payload": payload,
    }


# ── Build install + app management builders (AgentToCloud) ───────────────────


def install_progress(
    job_id: str,
    tv_id: str,
    status: str,
    progress: float,
    message: str | None = None,
) -> dict[str, Any]:
    """Mirror InstallProgress (agent-protocol.ts). `status` is an InstallStatus; `progress`
    is clamped 0..1. The cloud's onInstallProgress reads job_id/status/progress/message and
    folds it into the InstallJob, also pushing install.update to the holder's dashboard."""
    out: dict[str, Any] = {
        "type": INSTALL_PROGRESS,
        "job_id": job_id,
        "tv_id": tv_id,
        "status": status,
        "progress": max(0.0, min(1.0, float(progress))),
    }
    if message is not None:
        out["message"] = message
    return out


def app_list_result(
    request_id: str, tv_id: str, apps: list[dict[str, Any]]
) -> dict[str, Any]:
    """Mirror AppListResult. `apps` is a list of AppInfo dicts {app_id, name?, version?, running?}."""
    return {
        "type": APP_LIST_RESULT,
        "request_id": request_id,
        "tv_id": tv_id,
        "apps": apps,
    }


def app_ack(
    request_id: str, tv_id: str, ok: bool, error: str | None = None
) -> dict[str, Any]:
    """Mirror AppAck — the response for app.launch / app.uninstall / tv.power."""
    out: dict[str, Any] = {
        "type": APP_ACK,
        "request_id": request_id,
        "tv_id": tv_id,
        "ok": ok,
    }
    if error is not None:
        out["error"] = error
    return out


def app_info(
    app_id: str,
    name: str | None = None,
    version: str | None = None,
    running: bool | None = None,
) -> dict[str, Any]:
    """Build one AppInfo entry (builds.ts). `app_id` is required; the rest are optional.
    `running` is only emitted when set (it's an optional field in the contract)."""
    out: dict[str, Any] = {
        "app_id": app_id,
        "name": name,
        "version": version,
    }
    if running is not None:
        out["running"] = running
    return out


# ── Inbound parsing ──────────────────────────────────────────────────────────


@dataclass(slots=True)
class InboundMessage:
    """A parsed CloudToAgent frame. `type` is the discriminator; `raw` is the full dict."""

    type: str
    raw: dict[str, Any]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)


def parse_inbound(data: str | bytes) -> InboundMessage | None:
    """Parse a raw WS frame into an InboundMessage. Returns None for non-JSON / missing type."""
    try:
        obj = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    msg_type = obj.get("type")
    if not isinstance(msg_type, str):
        return None
    return InboundMessage(type=msg_type, raw=obj)


# ── Optional JSON Schema validation (best effort) ────────────────────────────


class _SchemaValidator:
    """Lazily loads the CloudToAgent branch of agent-protocol.schema.json and validates inbound
    frames against it. Silently no-ops if jsonschema or the schema file is unavailable — the
    schema lives under packages/contracts which may not ship with the agent in production."""

    def __init__(self) -> None:
        self._validator: Any = None
        self._tried = False

    def _load(self) -> None:
        self._tried = True
        try:
            import jsonschema  # type: ignore
        except ImportError:
            return
        schema_path = _find_schema_file()
        if schema_path is None:
            return
        try:
            with schema_path.open("r", encoding="utf-8") as fh:
                full = json.load(fh)
        except (OSError, json.JSONDecodeError):
            return
        cloud_to_agent = full.get("CloudToAgent")
        if not isinstance(cloud_to_agent, dict):
            return
        # The schema uses $defs / sibling $refs (#/ReportedTv etc). Resolve against the full doc.
        try:
            resolver = jsonschema.RefResolver.from_schema(full)  # type: ignore[attr-defined]
            self._validator = jsonschema.Draft202012Validator(  # type: ignore[attr-defined]
                cloud_to_agent, resolver=resolver
            )
        except Exception:  # noqa: BLE001 — validation is strictly best-effort
            self._validator = None

    def validate(self, frame: dict[str, Any]) -> str | None:
        """Return None if valid (or validation unavailable), else a short error string."""
        if not self._tried:
            self._load()
        if self._validator is None:
            return None
        try:
            errors = sorted(self._validator.iter_errors(frame), key=lambda e: e.path)
            if errors:
                return errors[0].message
        except Exception:  # noqa: BLE001
            return None
        return None


def _find_schema_file() -> Path | None:
    """Walk up from this module to locate packages/contracts/schemas/agent-protocol.schema.json.
    Works whether the agent is installed in-tree (monorepo) or standalone (returns None)."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "packages" / "contracts" / "schemas" / "agent-protocol.schema.json"
        if candidate.exists():
            return candidate
    return None


# Module-level singleton so the schema is parsed at most once.
schema_validator = _SchemaValidator()
