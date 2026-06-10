"""Install orchestration for build deployment (the upload-and-install feature).

On an inbound `install.build` frame the cloud hands down {job_id, tv_id, build_id, download_url,
package_kind, app_id}. This module:
  1. emits install.progress(status="downloading", ~0.1)
  2. streams the build from `download_url` to a temp file, authenticating with the agent shared
     secret header (x-agent-secret) the cloud's /builds/:id/download route checks; reports
     progress as bytes arrive.
  3. emits install.progress(status="installing", ~0.6) and calls adapter.install_build(...),
     which may emit further "installing" ticks via the progress callback.
  4. on success emits install.progress(status="installed", 1.0); on ANY failure emits
     status="failed" with the error message. The temp file is always cleaned up.

Progress frames go straight up the cloud tunnel (protocol.install_progress); the cloud's
InstallService persists them and pushes install.update to the holder's dashboard. All status
strings are InstallStatus values from packages/contracts/src/builds.ts.
"""

from __future__ import annotations

import logging
import os
import tempfile
from typing import Any

import aiohttp

from . import protocol
from .adapters import AppActionUnsupportedError, TvAdapter

log = logging.getLogger("device_lab_agent.installer")

# Extension per package kind for the temp file (cosmetic; some CLIs sniff the suffix).
_SUFFIX = {"apk": ".apk", "wgt": ".wgt", "ipk": ".ipk"}

# Stream chunk size when downloading the build.
_CHUNK = 256 * 1024


class Installer:
    """Runs install jobs end-to-end and streams install.progress up the cloud tunnel."""

    def __init__(self, cfg: Any, send_frame, adapters: dict[str, TvAdapter]) -> None:
        # `send_frame` is an async callable taking a frame dict (AgentApp wires it to cloud.send).
        self.cfg = cfg
        self._send = send_frame
        self._adapters = adapters

    async def run(
        self,
        *,
        job_id: str,
        tv_id: str,
        build_id: str,
        download_url: str,
        package_kind: str,
        app_id: str | None,
    ) -> None:
        adapter = self._adapters.get(tv_id)
        if adapter is None:
            await self._progress(job_id, tv_id, "failed", 0.0, f"unknown TV {tv_id}")
            return

        tmp_path: str | None = None
        try:
            await self._progress(job_id, tv_id, "downloading", 0.1, "fetching build")
            tmp_path = await self._download(download_url, package_kind)

            await self._progress(job_id, tv_id, "installing", 0.6, "running installer")

            async def on_adapter_progress(status: str, fraction: float, message: str | None) -> None:
                # Forward adapter-emitted ticks (typically "installing").
                await self._progress(job_id, tv_id, status, fraction, message)

            await adapter.install_build(tmp_path, package_kind, app_id, on_adapter_progress)

            await self._progress(job_id, tv_id, "installed", 1.0, None)
            log.info("install job %s on %s: installed (build=%s)", job_id, tv_id, build_id)
        except AppActionUnsupportedError as exc:
            await self._progress(job_id, tv_id, "failed", 0.0, f"unsupported: {exc}")
            log.warning("install job %s on %s unsupported: %s", job_id, tv_id, exc)
        except Exception as exc:  # noqa: BLE001 — any failure becomes a failed job, not a crash
            await self._progress(job_id, tv_id, "failed", 0.0, str(exc))
            log.warning("install job %s on %s failed: %s", job_id, tv_id, exc)
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError as exc:
                    log.debug("temp cleanup failed for %s: %s", tmp_path, exc)

    async def _download(self, url: str, package_kind: str) -> str:
        """Stream the build to a temp file, authenticating as the agent. Returns the temp path."""
        suffix = _SUFFIX.get(package_kind, "")
        fd, tmp_path = tempfile.mkstemp(prefix="devicelab-build-", suffix=suffix)
        os.close(fd)
        headers = {"x-agent-secret": self.cfg.agent_shared_secret}
        timeout = aiohttp.ClientTimeout(total=600, sock_read=120)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, headers=headers) as resp:
                    if resp.status != 200:
                        body = (await resp.text())[:200]
                        raise RuntimeError(f"download failed: HTTP {resp.status} {body}")
                    with open(tmp_path, "wb") as fh:
                        async for chunk in resp.content.iter_chunked(_CHUNK):
                            fh.write(chunk)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        size = os.path.getsize(tmp_path)
        log.info("downloaded build to %s (%d bytes)", tmp_path, size)
        return tmp_path

    async def _progress(
        self, job_id: str, tv_id: str, status: str, fraction: float, message: str | None
    ) -> None:
        await self._send(
            protocol.install_progress(job_id, tv_id, status, fraction, message)
        )
