"""Shared helper for invoking vendor CLIs (adb / tizen / sdb / ares-*) from the real adapters.

Every install / app-management call on a hardware TV shells out to a vendor tool. This module
centralizes that: resolve the executable, run it off the event loop via
asyncio.create_subprocess_exec, capture stdout/stderr, and translate failures into the adapter
exceptions the app layer already understands (AppActionUnsupportedError when the tool is missing,
TvControlError when it runs but fails). Keeping it here means samsung/lg/androidtv stay thin and
behave identically around process handling.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from dataclasses import dataclass

from .base import AppActionUnsupportedError, TvControlError

log = logging.getLogger("device_lab_agent.adapter.cli")


@dataclass(slots=True)
class CliResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    @property
    def text(self) -> str:
        """stdout if non-empty, else stderr — whichever carries the tool's output."""
        return self.stdout if self.stdout.strip() else self.stderr


def resolve_tool(path_or_name: str | None, default: str) -> str:
    """Resolve a configured CLI path (or bare name) to an executable, falling back to `default`
    on PATH. Raise AppActionUnsupportedError if nothing usable is found — the cloud then surfaces
    "unsupported" instead of a confusing crash."""
    candidate = path_or_name or default
    # Accept an absolute/relative path that exists, or a name resolvable on PATH.
    found = shutil.which(candidate)
    if found:
        return found
    raise AppActionUnsupportedError(
        f"required tool {candidate!r} not found "
        f"(set the corresponding *_PATH env var, or install device-lab-agent[hardware])"
    )


async def run_cli(
    argv: list[str],
    *,
    timeout: float = 180.0,
    check: bool = True,
    label: str | None = None,
) -> CliResult:
    """Run `argv` to completion off the event loop, capturing output.

    Raises:
      AppActionUnsupportedError  — the executable could not be spawned (missing tool).
      TvControlError             — non-zero exit (when check=True) or a timeout.
    """
    tag = label or argv[0]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise AppActionUnsupportedError(f"{tag}: executable not found ({exc})") from exc
    try:
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        raise TvControlError(f"{tag}: timed out after {timeout:.0f}s") from exc

    result = CliResult(
        returncode=proc.returncode if proc.returncode is not None else -1,
        stdout=out_b.decode(errors="replace"),
        stderr=err_b.decode(errors="replace"),
    )
    log.debug("%s rc=%s out=%r err=%r", tag, result.returncode, result.stdout[:400], result.stderr[:400])
    if check and not result.ok:
        msg = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise TvControlError(f"{tag} failed: {msg}")
    return result
