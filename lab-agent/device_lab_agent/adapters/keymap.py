"""Normalized RemoteKey -> vendor code maps, keyed by the RemoteKey strings the dashboard emits
(packages/contracts/src/keymap.ts). One vocabulary, three protocols underneath.

The dashboard only ever sends one of REMOTE_KEYS; each adapter looks its key up here. A key that
maps to None (or is absent) is "unsupported" for that platform — the adapter reports it cleanly
rather than guessing, matching the KeyPressResponse "unsupported_key" reason in api.ts.
"""

from __future__ import annotations

# The full normalized set (mirrors REMOTE_KEYS in keymap.ts). Used for validation/logging.
REMOTE_KEYS: tuple[str, ...] = (
    "UP",
    "DOWN",
    "LEFT",
    "RIGHT",
    "OK",
    "BACK",
    "HOME",
    "PLAY",
    "PAUSE",
    "MENU",
    "VOLUME_UP",
    "VOLUME_DOWN",
    "MUTE",
    "CHANNEL_UP",
    "CHANNEL_DOWN",
    "POWER",
    "PLAY_PAUSE",
    "STOP",
    "REWIND",
    "FAST_FORWARD",
)

# Subset every adapter MUST implement (CORE_REMOTE_KEYS in keymap.ts).
CORE_REMOTE_KEYS: tuple[str, ...] = (
    "UP",
    "DOWN",
    "LEFT",
    "RIGHT",
    "OK",
    "BACK",
    "HOME",
    "PLAY",
    "PAUSE",
)


def is_remote_key(k: str) -> bool:
    return k in REMOTE_KEYS


# ── Samsung Tizen (samsungtvws) ──────────────────────────────────────────────
# Vendor codes are the KEY_* strings samsungtvws sends over its remote websocket.
SAMSUNG_KEYMAP: dict[str, str] = {
    "UP": "KEY_UP",
    "DOWN": "KEY_DOWN",
    "LEFT": "KEY_LEFT",
    "RIGHT": "KEY_RIGHT",
    "OK": "KEY_ENTER",
    "BACK": "KEY_RETURN",
    "HOME": "KEY_HOME",
    "PLAY": "KEY_PLAY",
    "PAUSE": "KEY_PAUSE",
    "MENU": "KEY_MENU",
    "VOLUME_UP": "KEY_VOLUP",
    "VOLUME_DOWN": "KEY_VOLDOWN",
    "MUTE": "KEY_MUTE",
    "CHANNEL_UP": "KEY_CHUP",
    "CHANNEL_DOWN": "KEY_CHDOWN",
    "POWER": "KEY_POWER",
    "PLAY_PAUSE": "KEY_PLAY_BACK",  # Tizen toggle play/pause
    "STOP": "KEY_STOP",
    "REWIND": "KEY_REWIND",
    "FAST_FORWARD": "KEY_FF",
}


# ── LG webOS (aiowebostv) ────────────────────────────────────────────────────
# Directional/OK/BACK/HOME ride the LG "input socket" pointer-button channel (button names).
# Transport + volume + channel + power go over SSAP URI requests. We tag each entry with its
# transport so the LG adapter knows whether to call button() or request().
#   ("button", "<NAME>")  -> input-socket button press
#   ("request", "<ssap uri>", {payload}) -> SSAP request
LG_KEYMAP: dict[str, tuple] = {
    "UP": ("button", "UP"),
    "DOWN": ("button", "DOWN"),
    "LEFT": ("button", "LEFT"),
    "RIGHT": ("button", "RIGHT"),
    "OK": ("button", "ENTER"),
    "BACK": ("button", "BACK"),
    "HOME": ("button", "HOME"),
    "MENU": ("button", "MENU"),
    "PLAY": ("request", "ssap://media.controls/play", {}),
    "PAUSE": ("request", "ssap://media.controls/pause", {}),
    "PLAY_PAUSE": ("request", "ssap://media.controls/play", {}),  # webOS has no single toggle
    "STOP": ("request", "ssap://media.controls/stop", {}),
    "REWIND": ("request", "ssap://media.controls/rewind", {}),
    "FAST_FORWARD": ("request", "ssap://media.controls/fastForward", {}),
    "VOLUME_UP": ("request", "ssap://audio/volumeUp", {}),
    "VOLUME_DOWN": ("request", "ssap://audio/volumeDown", {}),
    "MUTE": ("request", "ssap://audio/setMute", {"mute": True}),
    "CHANNEL_UP": ("request", "ssap://tv/channelUp", {}),
    "CHANNEL_DOWN": ("request", "ssap://tv/channelDown", {}),
    "POWER": ("request", "ssap://system/turnOff", {}),
}


# ── Android TV (androidtvremote2) ────────────────────────────────────────────
# Vendor codes are the KeyCode names the Android TV remote v2 protocol accepts.
ANDROIDTV_KEYMAP: dict[str, str] = {
    "UP": "DPAD_UP",
    "DOWN": "DPAD_DOWN",
    "LEFT": "DPAD_LEFT",
    "RIGHT": "DPAD_RIGHT",
    "OK": "DPAD_CENTER",
    "BACK": "BACK",
    "HOME": "HOME",
    "MENU": "MENU",
    "PLAY": "MEDIA_PLAY",
    "PAUSE": "MEDIA_PAUSE",
    "PLAY_PAUSE": "MEDIA_PLAY_PAUSE",
    "STOP": "MEDIA_STOP",
    "REWIND": "MEDIA_REWIND",
    "FAST_FORWARD": "MEDIA_FAST_FORWARD",
    "VOLUME_UP": "VOLUME_UP",
    "VOLUME_DOWN": "VOLUME_DOWN",
    "MUTE": "VOLUME_MUTE",
    "CHANNEL_UP": "CHANNEL_UP",
    "CHANNEL_DOWN": "CHANNEL_DOWN",
    "POWER": "POWER",
}
