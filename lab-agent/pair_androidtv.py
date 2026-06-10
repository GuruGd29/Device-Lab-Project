"""One-shot Android TV remote-v2 pairing helper.

Flow: generate self-signed cert -> async_start_pairing() (TV shows a 6-digit code) ->
read the code (auto via uiautomator, else from /tmp/pair_code.txt which a human/screenshot
fills) -> async_finish_pairing(code) -> verify by reconnecting. Stores cert.pem/key.pem under
the given secret dir so the lab agent's AndroidTvAdapter reconnects silently (spec §14).
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from androidtvremote2 import AndroidTVRemote

HOST = os.environ.get("TV_IP", "192.168.20.108")
SERIAL = os.environ.get("TV_SERIAL", f"{HOST}:5555")
SECRET_DIR = Path(os.environ["TV_SECRET_DIR"])
CODE_FILE = Path(os.environ.get("CODE_FILE", "/tmp/pair_code.txt"))
SHOT = Path(os.environ.get("SHOT", "/tmp/tv_pair.png"))


def log(msg: str) -> None:
    print(msg, flush=True)


def screencap() -> None:
    try:
        png = subprocess.run(
            ["adb", "-s", SERIAL, "exec-out", "screencap", "-p"],
            capture_output=True, timeout=15,
        ).stdout
        if png:
            SHOT.write_bytes(png)
    except Exception as exc:  # noqa: BLE001
        log(f"screencap failed: {exc}")


def try_uiautomator_code() -> str | None:
    """Best-effort: dump the view hierarchy and look for a standalone 6-char code."""
    try:
        subprocess.run(["adb", "-s", SERIAL, "shell", "uiautomator", "dump", "/sdcard/u.xml"],
                       capture_output=True, timeout=15)
        xml = subprocess.run(["adb", "-s", SERIAL, "shell", "cat", "/sdcard/u.xml"],
                             capture_output=True, timeout=15, text=True).stdout
        for m in re.findall(r'text="([A-Za-z0-9]{6})"', xml):
            if any(c.isdigit() for c in m):  # codes contain digits; skip plain words
                return m.upper()
    except Exception:  # noqa: BLE001
        pass
    return None


async def main() -> int:
    SECRET_DIR.mkdir(parents=True, exist_ok=True)
    cert = str(SECRET_DIR / "cert.pem")
    key = str(SECRET_DIR / "key.pem")
    CODE_FILE.unlink(missing_ok=True)

    remote = AndroidTVRemote("Device Lab Agent", cert, key, HOST)
    await remote.async_generate_cert_if_missing()
    log("generated cert (if missing); starting pairing...")
    await remote.async_start_pairing()
    time.sleep(2.0)
    screencap()
    log(f"PAIRING_STARTED (code is on the TV; screenshot at {SHOT})")

    code: str | None = None
    deadline = time.time() + 180
    while time.time() < deadline:
        if CODE_FILE.exists():
            code = CODE_FILE.read_text().strip().upper()
            if code:
                log(f"got code from file: {code}")
                break
        auto = try_uiautomator_code()
        if auto:
            code = auto
            log(f"got code from uiautomator: {code}")
            break
        screencap()
        time.sleep(2.0)

    if not code:
        log("PAIRED_FAIL: no pairing code obtained within timeout")
        return 2

    try:
        await remote.async_finish_pairing(code)
    except Exception as exc:  # noqa: BLE001
        log(f"PAIRED_FAIL: finish_pairing({code}) -> {exc}")
        return 3

    # Verify the stored cert is now authorized by reconnecting fresh.
    verify = AndroidTVRemote("Device Lab Agent", cert, key, HOST)
    await verify.async_generate_cert_if_missing()
    await verify.async_connect()
    name, mac = await verify.async_get_name_and_mac()
    verify.disconnect()
    log(f"PAIRED_OK name={name!r} mac={mac} cert={cert}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
