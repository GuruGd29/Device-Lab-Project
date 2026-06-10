"""Cloud control tunnel client — asyncio `websockets`.

Connects OUT to the cloud /agent endpoint, authenticates with AGENT_SHARED_SECRET in the hello
frame, then:
  * on agent.welcome -> send agent.register_devices (full inventory) and start the heartbeat loop
    at welcome.heartbeat_interval_seconds, reporting each TV's control-session status and each
    camera's status + sfu_publish_track.
  * dispatch inbound CloudToAgent frames to the AgentApp's handlers.
  * reconnect with exponential backoff on drop; tokens/keys persist in the adapters, so a
    reconnect is silent (spec §14) — devices are simply re-registered.

This module owns ONLY the socket + framing. All device/media behaviour lives behind the
`handler` (AgentApp) so the protocol layer stays thin and testable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, Protocol

import websockets
from websockets.exceptions import ConnectionClosed

from . import protocol
from .config import Config

log = logging.getLogger("device_lab_agent.cloud")


class AgentHandler(Protocol):
    """What the cloud client needs from the application core. Implemented by AgentApp."""

    def build_register_devices(self) -> dict[str, Any]: ...
    def build_heartbeat(self) -> dict[str, Any]: ...
    async def on_calibrate_start(self, tv_id: str, code_payload: str) -> None: ...
    async def on_calibrate_clear(self, tv_id: str) -> None: ...
    async def on_key_press(self, request_id: str, tv_id: str, key: str) -> None: ...
    async def on_stream_request(
        self, tv_id: str, camera_id: str, dashboard_session: str
    ) -> None: ...
    async def on_stream_teardown(self, tv_id: str, dashboard_session: str) -> None: ...
    async def on_signal_offer(self, tv_id: str, dashboard_session: str, payload: Any) -> None: ...
    async def on_signal_candidate(
        self, tv_id: str, dashboard_session: str, payload: Any
    ) -> None: ...
    async def on_tv_connect(self, tv_id: str) -> None: ...
    async def on_tv_disconnect(self, tv_id: str) -> None: ...
    async def on_install_build(
        self,
        job_id: str,
        tv_id: str,
        build_id: str,
        download_url: str,
        package_kind: str,
        app_id: str | None,
    ) -> None: ...
    async def on_app_launch(self, request_id: str, tv_id: str, app_id: str) -> None: ...
    async def on_app_list(self, request_id: str, tv_id: str) -> None: ...
    async def on_app_uninstall(self, request_id: str, tv_id: str, app_id: str) -> None: ...
    async def on_tv_power(self, request_id: str, tv_id: str, on: bool) -> None: ...


class CloudClient:
    def __init__(self, cfg: Config, handler: AgentHandler) -> None:
        self.cfg = cfg
        self.handler = handler
        self._ws: Any = None
        self._send_lock = asyncio.Lock()
        self._stop = asyncio.Event()
        self._heartbeat_interval = 10.0

    async def send(self, frame: dict[str, Any]) -> None:
        """Serialize + send a frame. Used by the SFU signal sender too (signal.answer/candidate).
        Guarded by a lock because multiple coroutines (heartbeat, signaling, acks) share the socket."""
        ws = self._ws
        if ws is None:
            log.debug("drop frame %s: socket not connected", frame.get("type"))
            return
        data = json.dumps(frame)
        async with self._send_lock:
            try:
                await ws.send(data)
            except ConnectionClosed:
                log.debug("send failed: connection closed (%s)", frame.get("type"))

    async def run_forever(self) -> None:
        """Connect/serve/reconnect loop with exponential backoff + jitter."""
        backoff = self.cfg.reconnect_min_seconds
        while not self._stop.is_set():
            try:
                await self._connect_and_serve()
                backoff = self.cfg.reconnect_min_seconds  # clean session => reset backoff
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — any connect/serve failure => retry
                log.warning("cloud tunnel error: %s", exc)
            if self._stop.is_set():
                break
            sleep_for = min(backoff, self.cfg.reconnect_max_seconds)
            sleep_for *= 0.5 + random.random()  # jitter to avoid thundering reconnects
            log.info("reconnecting to cloud in %.1fs", sleep_for)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=sleep_for)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, self.cfg.reconnect_max_seconds)

    async def _connect_and_serve(self) -> None:
        log.info("connecting to cloud %s as agent %s", self.cfg.cloud_ws_url, self.cfg.agent_id)
        async with websockets.connect(
            self.cfg.cloud_ws_url,
            ping_interval=20,
            ping_timeout=20,
            max_size=4 * 1024 * 1024,
        ) as ws:
            self._ws = ws
            try:
                await self._handshake(ws)
                hb_task = asyncio.create_task(self._heartbeat_loop())
                try:
                    await self._receive_loop(ws)
                finally:
                    hb_task.cancel()
                    try:
                        await hb_task
                    except asyncio.CancelledError:
                        pass
            finally:
                self._ws = None

    async def _handshake(self, ws: Any) -> None:
        """Send agent.hello, await agent.welcome, then register devices."""
        hello = protocol.agent_hello(
            self.cfg.agent_id,
            self.cfg.agent_shared_secret,
            sfu_signaling_url=self.cfg.sfu_signaling_url,
            version=self.cfg.version,
            hostname=self.cfg.hostname,
        )
        await ws.send(json.dumps(hello))

        # Await the welcome (first server frame). A bad secret closes the socket with 4401.
        raw = await asyncio.wait_for(ws.recv(), timeout=15)
        msg = protocol.parse_inbound(raw)
        if msg is None or msg.type != protocol.AGENT_WELCOME:
            raise RuntimeError(f"expected agent.welcome, got {msg.type if msg else 'non-JSON'}")
        interval = msg.get("heartbeat_interval_seconds")
        if isinstance(interval, (int, float)) and interval > 0:
            self._heartbeat_interval = float(interval)
        log.info("agent welcomed; heartbeat every %.0fs", self._heartbeat_interval)

        # Full inventory snapshot on connect (and the reconnect re-registers silently).
        await self.send(self.handler.build_register_devices())

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(self._heartbeat_interval)
            await self.send(self.handler.build_heartbeat())

    async def _receive_loop(self, ws: Any) -> None:
        async for raw in ws:
            msg = protocol.parse_inbound(raw)
            if msg is None:
                log.debug("ignoring non-JSON / typeless frame")
                continue
            # Best-effort schema validation (CloudToAgent branch); never blocks handling.
            err = protocol.schema_validator.validate(msg.raw)
            if err:
                log.debug("inbound %s failed schema check: %s", msg.type, err)
            await self._dispatch(msg)

    async def _dispatch(self, msg: protocol.InboundMessage) -> None:
        t = msg.type
        try:
            if t == protocol.CALIBRATE_START:
                await self.handler.on_calibrate_start(msg.get("tv_id"), msg.get("code_payload"))
            elif t == protocol.CALIBRATE_CLEAR:
                await self.handler.on_calibrate_clear(msg.get("tv_id"))
            elif t == protocol.KEY_PRESS:
                await self.handler.on_key_press(
                    msg.get("request_id"), msg.get("tv_id"), msg.get("key")
                )
            elif t == protocol.STREAM_REQUEST:
                await self.handler.on_stream_request(
                    msg.get("tv_id"), msg.get("camera_id"), msg.get("dashboard_session")
                )
            elif t == protocol.STREAM_TEARDOWN:
                await self.handler.on_stream_teardown(
                    msg.get("tv_id"), msg.get("dashboard_session")
                )
            elif t == protocol.SIGNAL_OFFER:
                await self.handler.on_signal_offer(
                    msg.get("tv_id"), msg.get("dashboard_session"), msg.get("payload")
                )
            elif t == protocol.SIGNAL_CANDIDATE_IN:
                await self.handler.on_signal_candidate(
                    msg.get("tv_id"), msg.get("dashboard_session"), msg.get("payload")
                )
            elif t == protocol.TV_CONNECT:
                await self.handler.on_tv_connect(msg.get("tv_id"))
            elif t == protocol.TV_DISCONNECT:
                await self.handler.on_tv_disconnect(msg.get("tv_id"))
            elif t == protocol.INSTALL_BUILD:
                await self.handler.on_install_build(
                    msg.get("job_id"),
                    msg.get("tv_id"),
                    msg.get("build_id"),
                    msg.get("download_url"),
                    msg.get("package_kind"),
                    msg.get("app_id"),
                )
            elif t == protocol.APP_LAUNCH:
                await self.handler.on_app_launch(
                    msg.get("request_id"), msg.get("tv_id"), msg.get("app_id")
                )
            elif t == protocol.APP_LIST:
                await self.handler.on_app_list(msg.get("request_id"), msg.get("tv_id"))
            elif t == protocol.APP_UNINSTALL:
                await self.handler.on_app_uninstall(
                    msg.get("request_id"), msg.get("tv_id"), msg.get("app_id")
                )
            elif t == protocol.TV_POWER:
                await self.handler.on_tv_power(
                    msg.get("request_id"), msg.get("tv_id"), msg.get("on")
                )
            else:
                log.debug("unhandled inbound type: %s", t)
        except Exception as exc:  # noqa: BLE001 — one bad frame must not kill the tunnel
            log.exception("handler for %s raised: %s", t, exc)

    def stop(self) -> None:
        self._stop.set()
