"""AgentApp — the application core. Implements the AgentHandler the CloudClient dispatches to,
owns the TV adapters + the SFU, and builds the register/heartbeat frames.

Responsibilities map 1:1 to the inbound CloudToAgent messages:
  calibrate.start   -> Calibrator.run -> calibration.result
  calibrate.clear   -> adapter.clear_qr
  key.press         -> adapter.press -> key.ack
  stream.request    -> Sfu.request_stream
  signal.offer      -> Sfu.handle_offer -> signal.answer
  signal.candidate  -> Sfu.handle_candidate (+ relay agent ICE up via the signal_sender)
  stream.teardown   -> Sfu.teardown_stream
  tv.connect        -> adapter.connect
  tv.disconnect     -> adapter.close
  install.build     -> Installer.run -> install.progress (downloading/installing/installed/failed)
  app.launch        -> adapter.launch_app    -> app.ack
  app.list          -> adapter.list_apps     -> app.list.result
  app.uninstall     -> adapter.uninstall_app -> app.ack
  tv.power          -> adapter.set_power      -> app.ack

Status reporting (heartbeat): a TV is `free` when its control session is reachable and `offline`
when not. The cloud's state machine folds in binding/camera health to derive the dashboard status
(no_camera/unhealthy/in_use) — the agent only reports what it can locally observe (spec §8: the
agent's reports DRIVE transitions; the cloud owns the registry).
"""

from __future__ import annotations

import logging
from typing import Any

from . import protocol
from .adapters import (
    AppActionUnsupportedError,
    KeyNotSupportedError,
    TvAdapter,
    TvControlError,
    build_adapter,
)
from .calibration import Calibrator
from .config import Config
from .installer import Installer
from .sfu import Sfu

log = logging.getLogger("device_lab_agent.app")


class AgentApp:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.adapters: dict[str, TvAdapter] = {}
        self._tv_by_id = {tv.tv_id: tv for tv in cfg.tvs}
        # Slot-based mapping so heartbeat camera->TV and the sim QR provider can correlate.
        self._camera_slot = {c.camera_id: c.slot_id for c in cfg.cameras}
        self._tv_slot = {tv.tv_id: tv.slot_id for tv in cfg.tvs}

        # The cloud client is attached after construction (it needs `self` as handler).
        self.cloud: Any = None
        self.sfu = Sfu(
            bind_host=cfg.sfu_bind_host,
            bind_port=cfg.sfu_bind_port,
            dev_simulate=cfg.dev_simulate,
            signal_sender=self._send_signal,
            qr_provider=self._qr_payload_for_camera,
        )
        self.calibrator = Calibrator(self.sfu, cfg.calibration_timeout_seconds)

        for tv in cfg.tvs:
            self.adapters[tv.tv_id] = build_adapter(tv, cfg)

        # Orchestrates download + per-platform install, streaming install.progress up the tunnel.
        # It sends through `self._send_frame`, which resolves `self.cloud` lazily (attached later).
        self.installer = Installer(cfg, self._send_frame, self.adapters)

    def attach_cloud(self, cloud: Any) -> None:
        self.cloud = cloud

    async def _send_frame(self, frame: dict[str, Any]) -> None:
        """Send a frame up the cloud tunnel if connected. Used by the installer."""
        if self.cloud is not None:
            await self.cloud.send(frame)

    # ── Lifecycle ───────────────────────────────────────────────────────────
    async def start(self) -> None:
        await self.sfu.start()
        # In DEV_SIMULATE, materialize a synthetic feed per camera up front so register/heartbeat
        # immediately report sfu_publish_track ids and calibration can match without a real phone.
        if self.cfg.dev_simulate:
            for cam in self.cfg.cameras:
                self.sfu.ensure_sim_camera(cam.camera_id)
        # Bring up vendor control sessions. In sim this just flips reachable=True; for real TVs
        # it opens the persistent session using the stored token/key/cert.
        for tv_id, adapter in self.adapters.items():
            try:
                await adapter.connect()
            except Exception as exc:  # noqa: BLE001
                log.warning("initial connect failed for %s: %s", tv_id, exc)

    async def stop(self) -> None:
        for adapter in self.adapters.values():
            try:
                await adapter.close()
            except Exception as exc:  # noqa: BLE001
                log.debug("adapter close error: %s", exc)
        await self.sfu.stop()

    # ── Frame builders (AgentToCloud) ─────────────────────────────────────────
    def build_register_devices(self) -> dict[str, Any]:
        tvs = [
            protocol.reported_tv(
                tv_id=tv.tv_id,
                platform=tv.platform,
                control_protocol=tv.control_protocol,
                status=self._tv_status(tv.tv_id),
                serial=tv.serial,
                firmware_version=tv.firmware_version,
                net_ip=tv.net_ip,
                mac=tv.mac,
                vlan=tv.vlan,
                slot_id=tv.slot_id,
                rack_position=tv.rack_position,
                control_secret_ref=tv.control_secret_ref,
            )
            for tv in self.cfg.tvs
        ]
        cameras = [
            protocol.reported_camera(
                camera_id=cam.camera_id,
                status=self._camera_status(cam.camera_id),
                slot_id=cam.slot_id,
                sfu_publish_track=self.sfu.publish_track_id(cam.camera_id),
            )
            for cam in self.cfg.cameras
        ]
        return protocol.agent_register_devices(self.cfg.agent_id, tvs, cameras)

    def build_heartbeat(self) -> dict[str, Any]:
        tvs = [protocol.heartbeat_tv(tv.tv_id, self._tv_status(tv.tv_id)) for tv in self.cfg.tvs]
        cameras = [
            protocol.heartbeat_camera(
                cam.camera_id,
                self._camera_status(cam.camera_id),
                sfu_publish_track=self.sfu.publish_track_id(cam.camera_id),
                slot_id=cam.slot_id,
            )
            for cam in self.cfg.cameras
        ]
        return protocol.agent_heartbeat(self.cfg.agent_id, tvs, cameras)

    def _tv_status(self, tv_id: str) -> str:
        """Local view of a TV's status -> a TvStatus enum value. The agent reports `free` when
        its control session is up, `offline` otherwise; the cloud refines this against camera
        binding health (spec §8)."""
        adapter = self.adapters.get(tv_id)
        if adapter is None:
            return "offline"
        return "free" if adapter.reachable else "offline"

    def _camera_status(self, camera_id: str) -> str:
        # Heartbeat timeout mirrors the cloud's window so we agree on liveness.
        return self.sfu.camera_status(camera_id, offline_after=30.0)

    # ── QR provider for the sim camera feed ───────────────────────────────────
    def _qr_payload_for_camera(self, camera_id: str) -> str | None:
        """For DEV_SIMULATE: if the TV bound to this camera's slot is currently rendering a
        calibration QR (SimAdapter.qr_payload set), return that payload so the synthetic frame
        draws it and calibration genuinely matches end-to-end."""
        slot = self._camera_slot.get(camera_id)
        if slot is None:
            return None
        for tv_id, tv_slot in self._tv_slot.items():
            if tv_slot != slot:
                continue
            adapter = self.adapters.get(tv_id)
            payload = getattr(adapter, "qr_payload", None)
            if payload:
                return payload
        return None

    # ── Signal sender used by the SFU to push answers/ICE up the tunnel ───────
    async def _send_signal(
        self, tv_id: str, dashboard_session: str, kind: str, payload: Any
    ) -> None:
        if self.cloud is None:
            return
        if kind == protocol.SIGNAL_ANSWER:
            frame = protocol.signal_answer(tv_id, dashboard_session, payload)
        else:  # signal.candidate
            frame = protocol.signal_candidate(tv_id, dashboard_session, payload)
        await self.cloud.send(frame)

    # ── Inbound handlers (CloudToAgent) ───────────────────────────────────────
    async def on_calibrate_start(self, tv_id: str, code_payload: str) -> None:
        adapter = self.adapters.get(tv_id)
        if adapter is None:
            log.warning("calibrate.start for unknown TV %s", tv_id)
            await self.cloud.send(protocol.calibration_result(tv_id, matched=False))
            return
        log.info("calibrate.start tv=%s payload=%s", tv_id, code_payload)
        result = await self.calibrator.run(tv_id, code_payload, adapter)
        await self.cloud.send(
            protocol.calibration_result(
                tv_id,
                matched=bool(result.get("matched")),
                camera_id=result.get("camera_id"),
                confidence=result.get("confidence"),
            )
        )

    async def on_calibrate_clear(self, tv_id: str) -> None:
        adapter = self.adapters.get(tv_id)
        if adapter is not None:
            try:
                await adapter.clear_qr()
            except Exception as exc:  # noqa: BLE001
                log.debug("calibrate.clear failed for %s: %s", tv_id, exc)

    async def on_key_press(self, request_id: str, tv_id: str, key: str) -> None:
        adapter = self.adapters.get(tv_id)
        if adapter is None:
            await self.cloud.send(
                protocol.key_ack(request_id, tv_id, ok=False, error="tv_unreachable")
            )
            return
        try:
            await adapter.press(key)
            await self.cloud.send(protocol.key_ack(request_id, tv_id, ok=True))
        except KeyNotSupportedError:
            await self.cloud.send(
                protocol.key_ack(request_id, tv_id, ok=False, error="unsupported_key")
            )
        except TvControlError as exc:
            await self.cloud.send(
                protocol.key_ack(request_id, tv_id, ok=False, error="tv_unreachable")
            )
            log.warning("key %s on %s failed: %s", key, tv_id, exc)
        except Exception as exc:  # noqa: BLE001
            await self.cloud.send(
                protocol.key_ack(request_id, tv_id, ok=False, error=str(exc))
            )

    async def on_stream_request(
        self, tv_id: str, camera_id: str, dashboard_session: str
    ) -> None:
        log.info("stream.request tv=%s cam=%s session=%s", tv_id, camera_id, dashboard_session)
        await self.sfu.request_stream(tv_id, camera_id, dashboard_session)

    async def on_stream_teardown(self, tv_id: str, dashboard_session: str) -> None:
        log.info("stream.teardown tv=%s session=%s", tv_id, dashboard_session)
        await self.sfu.teardown_stream(tv_id, dashboard_session)

    async def on_signal_offer(self, tv_id: str, dashboard_session: str, payload: Any) -> None:
        await self.sfu.handle_offer(tv_id, dashboard_session, payload)

    async def on_signal_candidate(
        self, tv_id: str, dashboard_session: str, payload: Any
    ) -> None:
        await self.sfu.handle_candidate(tv_id, dashboard_session, payload)

    async def on_tv_connect(self, tv_id: str) -> None:
        adapter = self.adapters.get(tv_id)
        if adapter is not None:
            await adapter.connect()

    async def on_tv_disconnect(self, tv_id: str) -> None:
        adapter = self.adapters.get(tv_id)
        if adapter is not None:
            await adapter.close()

    # ── Build install + app management ("other TV options") ───────────────────
    async def on_install_build(
        self,
        job_id: str,
        tv_id: str,
        build_id: str,
        download_url: str,
        package_kind: str,
        app_id: str | None,
    ) -> None:
        """Hand the job to the installer, which downloads + installs and streams install.progress.
        Runs to completion within this dispatch; install.progress frames carry the live status."""
        log.info(
            "install.build job=%s tv=%s build=%s kind=%s app_id=%s",
            job_id,
            tv_id,
            build_id,
            package_kind,
            app_id,
        )
        await self.installer.run(
            job_id=job_id,
            tv_id=tv_id,
            build_id=build_id,
            download_url=download_url,
            package_kind=package_kind,
            app_id=app_id,
        )

    async def on_app_launch(self, request_id: str, tv_id: str, app_id: str) -> None:
        await self._app_action(
            request_id, tv_id, lambda a: a.launch_app(app_id), what="launch"
        )

    async def on_app_uninstall(self, request_id: str, tv_id: str, app_id: str) -> None:
        await self._app_action(
            request_id, tv_id, lambda a: a.uninstall_app(app_id), what="uninstall"
        )

    async def on_tv_power(self, request_id: str, tv_id: str, on: bool) -> None:
        await self._app_action(
            request_id, tv_id, lambda a: a.set_power(on), what="power"
        )

    async def _app_action(self, request_id: str, tv_id: str, action, *, what: str) -> None:
        """Run a launch/uninstall/power action and reply app.ack. Error strings map in the cloud's
        runAck: error=="unsupported" -> reason "unsupported", anything else -> "tv_unreachable"."""
        adapter = self.adapters.get(tv_id)
        if adapter is None:
            await self.cloud.send(
                protocol.app_ack(request_id, tv_id, ok=False, error="tv_unreachable")
            )
            return
        try:
            await action(adapter)
            await self.cloud.send(protocol.app_ack(request_id, tv_id, ok=True))
        except AppActionUnsupportedError as exc:
            await self.cloud.send(
                protocol.app_ack(request_id, tv_id, ok=False, error="unsupported")
            )
            log.warning("%s on %s unsupported: %s", what, tv_id, exc)
        except TvControlError as exc:
            await self.cloud.send(
                protocol.app_ack(request_id, tv_id, ok=False, error="tv_unreachable")
            )
            log.warning("%s on %s failed: %s", what, tv_id, exc)
        except Exception as exc:  # noqa: BLE001
            await self.cloud.send(
                protocol.app_ack(request_id, tv_id, ok=False, error=str(exc))
            )
            log.warning("%s on %s errored: %s", what, tv_id, exc)

    async def on_app_list(self, request_id: str, tv_id: str) -> None:
        """List installed apps and reply app.list.result. On any failure reply an empty list so
        the cloud's listApps promise resolves (the dashboard simply shows nothing)."""
        adapter = self.adapters.get(tv_id)
        if adapter is None:
            await self.cloud.send(protocol.app_list_result(request_id, tv_id, []))
            return
        try:
            raw = await adapter.list_apps()
            apps = [
                protocol.app_info(
                    app_id=str(a.get("app_id")),
                    name=a.get("name"),
                    version=a.get("version"),
                    running=a.get("running"),
                )
                for a in raw
                if a.get("app_id")
            ]
            await self.cloud.send(protocol.app_list_result(request_id, tv_id, apps))
        except Exception as exc:  # noqa: BLE001
            await self.cloud.send(protocol.app_list_result(request_id, tv_id, []))
            log.warning("list-apps on %s failed: %s", tv_id, exc)
