"""TV control adapters. `build_adapter` picks the right one from a TvConfig + run mode.

In DEV_SIMULATE every TV gets a SimAdapter (no hardware). Otherwise the control_protocol selects
the vendor adapter. Vendor modules import their heavy SDKs lazily inside connect(), so importing
this package never pulls in samsungtvws/aiowebostv/androidtvremote2 — keeping the sim path light.
"""

from __future__ import annotations

from ..config import Config, TvConfig
from .base import (
    AppActionUnsupportedError,
    KeyNotSupportedError,
    ProgressCallback,
    TvAdapter,
    TvControlError,
)
from .simulator import SimAdapter

__all__ = [
    "TvAdapter",
    "TvControlError",
    "KeyNotSupportedError",
    "AppActionUnsupportedError",
    "ProgressCallback",
    "SimAdapter",
    "build_adapter",
]


def build_adapter(tv: TvConfig, cfg: Config) -> TvAdapter:
    """Instantiate the control adapter for one TV. Raises ValueError on an unknown protocol."""
    if cfg.dev_simulate:
        return SimAdapter(tv.tv_id)

    # The calibration page is served by THIS agent's local SFU/HTTP server. Vendor adapters open
    # the TV browser there to display the QR. Reachable host = the SFU bind host unless 0.0.0.0,
    # in which case fall back to the advertised signaling URL host.
    calibration_base_url = cfg.sfu_signaling_url

    if tv.control_protocol == "samsung_ws":
        from .samsung import SamsungAdapter

        return SamsungAdapter(
            tv.tv_id,
            tv.net_ip,
            tv.control_secret_ref,
            calibration_base_url,
            tizen_path=cfg.tizen_path,
            sdb_path=cfg.sdb_path,
            tizen_target=cfg.tizen_target,
        )
    if tv.control_protocol == "lg_ssap":
        from .lg import LgAdapter

        return LgAdapter(
            tv.tv_id,
            tv.net_ip,
            tv.control_secret_ref,
            calibration_base_url,
            ares_path=cfg.ares_path,
            ares_device=cfg.ares_device,
        )
    if tv.control_protocol == "androidtv_remote":
        from .androidtv import AndroidTvAdapter

        return AndroidTvAdapter(
            tv.tv_id,
            tv.net_ip,
            tv.control_secret_ref,
            calibration_base_url,
            adb_path=cfg.adb_path,
        )
    raise ValueError(f"unknown control_protocol {tv.control_protocol!r} for TV {tv.tv_id}")
