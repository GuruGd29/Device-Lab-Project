"""Dispatch-level acceptance: feed CloudToAgent frames through CloudClient._dispatch into a real
AgentApp (DEV_SIMULATE) and assert the AgentToCloud frames it sends back match the cloud's
agentHub expectations (app.ack {request_id, tv_id, ok, error?}, app.list.result {request_id,
tv_id, apps[]}, install.progress {job_id, tv_id, status, progress, message?}).

This proves the routing added to app.py + cloud_client.py end-to-end, including the install.build
download path (served by a local stand-in for the cloud's /builds/:id/download route).

Run:  .venv/bin/python tests/test_app_dispatch.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Force the zero-config simulated inventory (two TVs, two cameras).
os.environ["DEV_SIMULATE"] = "1"
os.environ.setdefault("AGENT_SHARED_SECRET", "test-secret-123")
os.environ.setdefault("SFU_SIGNALING_URL", "http://127.0.0.1:0")

from aiohttp import web

from device_lab_agent import protocol
from device_lab_agent.app import AgentApp
from device_lab_agent.cloud_client import CloudClient
from device_lab_agent.config import load_config

AGENT_SECRET = "test-secret-123"
BUILD_BYTES = b"PK\x03\x04 fake wgt " * 64


class FakeCloud:
    """Stands in for CloudClient.send — captures every outbound frame."""

    def __init__(self) -> None:
        self.frames: list[dict] = []

    async def send(self, frame: dict) -> None:
        self.frames.append(frame)


async def _start_server() -> tuple[web.AppRunner, str]:
    async def download(request: web.Request) -> web.Response:
        if request.headers.get("x-agent-secret") != AGENT_SECRET:
            return web.Response(status=401, text="bad secret")
        return web.Response(body=BUILD_BYTES, content_type="application/octet-stream")

    app = web.Application()
    app.router.add_get("/builds/{id}/download", download)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = list(site._server.sockets)[0].getsockname()[1]  # type: ignore[attr-defined]
    return runner, f"http://127.0.0.1:{port}"


def _check(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    print(f"  OK: {msg}")


async def main() -> int:
    cfg = load_config()
    tv_id = cfg.tvs[0].tv_id  # tv-sim-samsung-01
    _check(tv_id == "tv-sim-samsung-01", f"first sim TV is the Samsung one ({tv_id})")

    app = AgentApp(cfg)
    cloud = FakeCloud()
    app.attach_cloud(cloud)
    # Bring sim adapters reachable (start() also touches the SFU; we only need adapters here).
    for a in app.adapters.values():
        await a.connect()

    client = CloudClient(cfg, app)

    async def dispatch(frame: dict) -> None:
        await client._dispatch(protocol.InboundMessage(type=frame["type"], raw=frame))

    runner, base = await _start_server()

    print("[1] install.build dispatch -> install.progress reaches installed")
    cloud.frames.clear()
    await dispatch(
        {
            "type": "install.build",
            "job_id": "J1",
            "tv_id": tv_id,
            "build_id": "b1",
            "download_url": f"{base}/builds/b1/download",
            "package_kind": "wgt",
            "app_id": "com.demo",
        }
    )
    prog = [f for f in cloud.frames if f["type"] == "install.progress"]
    _check(prog[0]["status"] == "downloading", "first install.progress is downloading")
    _check(prog[-1]["status"] == "installed" and prog[-1]["progress"] == 1.0, "ends installed @1.0")
    _check(all(f["job_id"] == "J1" and f["tv_id"] == tv_id for f in prog), "job_id/tv_id correlated")

    print("[2] app.list dispatch -> app.list.result with the installed app")
    cloud.frames.clear()
    await dispatch({"type": "app.list", "request_id": "R1", "tv_id": tv_id})
    res = cloud.frames[-1]
    _check(res["type"] == "app.list.result", "replied app.list.result")
    _check(res["request_id"] == "R1" and res["tv_id"] == tv_id, "request_id/tv_id correlated")
    ids = {a["app_id"] for a in res["apps"]}
    _check("com.demo" in ids, "installed com.demo appears in list")
    _check(all({"app_id", "name", "version"} <= set(a) for a in res["apps"]), "AppInfo keys present")

    print("[3] app.launch dispatch -> app.ack ok")
    cloud.frames.clear()
    await dispatch({"type": "app.launch", "request_id": "R2", "tv_id": tv_id, "app_id": "com.demo"})
    ack = cloud.frames[-1]
    _check(ack["type"] == "app.ack" and ack["ok"] is True, "app.launch -> app.ack ok=true")
    _check(ack["request_id"] == "R2" and ack["tv_id"] == tv_id, "ack correlated")
    _check("error" not in ack, "successful ack omits error")

    print("[4] tv.power dispatch -> app.ack ok")
    cloud.frames.clear()
    await dispatch({"type": "tv.power", "request_id": "R3", "tv_id": tv_id, "on": False})
    _check(cloud.frames[-1]["ok"] is True, "tv.power off -> ok=true")

    print("[5] app.uninstall dispatch -> app.ack ok, app gone")
    cloud.frames.clear()
    await dispatch({"type": "app.uninstall", "request_id": "R4", "tv_id": tv_id, "app_id": "com.demo"})
    _check(cloud.frames[-1]["ok"] is True, "app.uninstall -> ok=true")
    after = await app.adapters[tv_id].list_apps()
    _check("com.demo" not in {a["app_id"] for a in after}, "com.demo removed after uninstall")

    print("[6] app.launch on unknown TV -> app.ack ok=false error=tv_unreachable")
    cloud.frames.clear()
    await dispatch({"type": "app.launch", "request_id": "R5", "tv_id": "nope", "app_id": "x"})
    bad = cloud.frames[-1]
    _check(bad["ok"] is False and bad.get("error") == "tv_unreachable", "unknown TV -> tv_unreachable")

    await runner.cleanup()
    await app.sfu.stop()
    print("\nALL DISPATCH CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
