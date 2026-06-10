"""Console entry point: `device-lab-agent`.

Wires config -> adapters (real per platform, or SimAdapter in DEV_SIMULATE) -> SFU aiohttp server
-> cloud tunnel client, then runs forever. Clean shutdown on SIGINT/SIGTERM tears down control
sessions, the SFU, and the tunnel.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal

from .app import AgentApp
from .cloud_client import CloudClient
from .config import load_config


def _setup_logging() -> None:
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


async def _run() -> None:
    cfg = load_config()
    log = logging.getLogger("device_lab_agent")
    log.info(
        "starting agent_id=%s cloud=%s sfu=%s dev_simulate=%s tvs=%d cameras=%d",
        cfg.agent_id,
        cfg.cloud_ws_url,
        cfg.sfu_signaling_url,
        cfg.dev_simulate,
        len(cfg.tvs),
        len(cfg.cameras),
    )

    app = AgentApp(cfg)
    client = CloudClient(cfg, app)
    app.attach_cloud(client)

    await app.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover - Windows
            pass

    tunnel = asyncio.create_task(client.run_forever())
    try:
        await stop.wait()
    finally:
        log.info("shutting down")
        client.stop()
        tunnel.cancel()
        try:
            await tunnel
        except asyncio.CancelledError:
            pass
        await app.stop()


def main() -> None:
    _setup_logging()
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
