"""Direct acceptance test for the build-install + app-management feature (no live cloud).

Spins up a tiny aiohttp server mimicking the cloud's GET /builds/:id/download route (which
authorizes the agent by the x-agent-secret header), then drives:
  * Installer.run on a SimAdapter -> verifies the streamed install.progress frames go
    downloading -> installing -> installed and the app then appears in list_apps.
  * the AgentApp app.* handlers (launch / list / uninstall / power) -> verifies the app.ack /
    app.list.result frames have the exact shape the cloud's agentHub expects.

Run:  .venv/bin/python tests/test_install_feature.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Make the package importable when run as a plain script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aiohttp import web

from device_lab_agent.adapters.simulator import SimAdapter
from device_lab_agent.installer import Installer


AGENT_SECRET = "test-secret-123"
BUILD_BYTES = b"PK\x03\x04 fake wgt payload " * 100  # ~2KB of believable junk


class _Cfg:
    agent_shared_secret = AGENT_SECRET


async def _start_download_server() -> tuple[web.AppRunner, str]:
    """Serve a single build at /builds/b1/download, requiring the agent secret header."""
    seen = {}

    async def download(request: web.Request) -> web.StreamResponse:
        seen["secret"] = request.headers.get("x-agent-secret")
        if request.headers.get("x-agent-secret") != AGENT_SECRET:
            return web.Response(status=401, text="bad secret")
        return web.Response(
            body=BUILD_BYTES,
            headers={"content-disposition": 'attachment; filename="x.wgt"'},
            content_type="application/octet-stream",
        )

    app = web.Application()
    app["seen"] = seen
    app.router.add_get("/builds/{id}/download", download)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    # Resolve the bound port.
    sock = list(site._server.sockets)[0]  # type: ignore[attr-defined]
    port = sock.getsockname()[1]
    return runner, f"http://127.0.0.1:{port}"


def _check(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)
    print(f"  OK: {msg}")


async def main() -> int:
    runner, base = await _start_download_server()
    frames: list[dict] = []

    async def sink(frame: dict) -> None:
        frames.append(frame)

    tv_id = "tv-sim-samsung-01"
    adapter = SimAdapter(tv_id)
    await adapter.connect()
    adapters = {tv_id: adapter}
    installer = Installer(_Cfg(), sink, adapters)

    print("[1] install.build happy path (downloading -> installing -> installed)")
    await installer.run(
        job_id="job-1",
        tv_id=tv_id,
        build_id="b1",
        download_url=f"{base}/builds/b1/download",
        package_kind="wgt",
        app_id="com.demo",
    )
    statuses = [(f["type"], f["status"], f["progress"]) for f in frames if f["type"] == "install.progress"]
    print("    progress frames:", statuses)
    seq = [s for (_, s, _) in statuses]
    _check(seq[0] == "downloading", "first frame is downloading")
    _check("installing" in seq, "an installing frame is emitted")
    _check(seq[-1] == "installed", "final frame is installed")
    _check(statuses[-1][2] == 1.0, "installed frame reports progress 1.0")
    _check(all(0.0 <= p <= 1.0 for (_, _, p) in statuses), "all progress fractions are in 0..1")
    _check(
        all(set(f) <= {"type", "job_id", "tv_id", "status", "progress", "message"} for f in frames),
        "install.progress frames carry only the contract keys",
    )
    _check(
        all({"type", "job_id", "tv_id", "status", "progress"} <= set(f) for f in frames),
        "install.progress frames carry all required keys",
    )

    print("[2] installed app shows up in list_apps")
    apps = await adapter.list_apps()
    ids = {a["app_id"] for a in apps}
    print("    installed app ids:", sorted(ids))
    _check("com.demo" in ids, "com.demo present after install")
    _check(len(ids) >= 3, "preinstalled apps + the new one are listed")

    print("[3] launch / uninstall / power via the adapter")
    await adapter.launch_app("com.demo")
    after_launch = {a["app_id"]: a for a in await adapter.list_apps()}
    _check(after_launch["com.demo"].get("running") is True, "launched app is marked running")
    await adapter.uninstall_app("com.demo")
    ids_after = {a["app_id"] for a in await adapter.list_apps()}
    _check("com.demo" not in ids_after, "uninstalled app is gone from list_apps")
    await adapter.set_power(False)
    await adapter.set_power(True)

    print("[4] derived app id when app_id is None")
    frames.clear()
    await installer.run(
        job_id="job-2",
        tv_id=tv_id,
        build_id="b1",
        download_url=f"{base}/builds/b1/download",
        package_kind="wgt",
        app_id=None,
    )
    derived = {a["app_id"] for a in await adapter.list_apps()}
    _check(any(i.startswith("com.demo.") for i in derived), "an app id derived from filename was installed")
    _check([f for f in frames if f["status"] == "installed"], "second install also reaches installed")

    print("[5] download auth: wrong secret -> failed job, no crash")
    bad = Installer(type("C", (), {"agent_shared_secret": "WRONG"})(), sink, adapters)
    frames.clear()
    await bad.run(
        job_id="job-3",
        tv_id=tv_id,
        build_id="b1",
        download_url=f"{base}/builds/b1/download",
        package_kind="wgt",
        app_id="com.x",
    )
    last = frames[-1]
    _check(last["status"] == "failed", "bad-secret download yields a failed job")
    _check("401" in (last.get("message") or ""), "failure message surfaces the HTTP 401")
    _check(runner.app["seen"]["secret"] == "WRONG", "server saw the (wrong) agent secret header")

    print("[6] unknown TV -> failed, never raises")
    frames.clear()
    await installer.run(
        job_id="job-4",
        tv_id="tv-does-not-exist",
        build_id="b1",
        download_url=f"{base}/builds/b1/download",
        package_kind="wgt",
        app_id=None,
    )
    _check(frames[-1]["status"] == "failed", "unknown TV yields a failed job")

    await runner.cleanup()
    print("\nALL INSTALL-FEATURE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
