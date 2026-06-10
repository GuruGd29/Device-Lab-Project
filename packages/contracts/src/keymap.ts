// Normalized remote keymap. The dashboard emits these abstract keys; the lab agent's
// per-platform adapters translate each into the vendor-specific code. One vocabulary,
// three protocols underneath (samsung_ws / lg_ssap / androidtv_remote).

/** The core directional + transport set required by the spec, plus common extras. */
export const REMOTE_KEYS = [
  // Core (spec §10) — every adapter MUST implement these.
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "OK",
  "BACK",
  "HOME",
  "PLAY",
  "PAUSE",
  // Common extended set — adapters SHOULD implement; dashboard may hide unsupported ones.
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
] as const;

export type RemoteKey = (typeof REMOTE_KEYS)[number];

/** The subset every adapter is required to support. */
export const CORE_REMOTE_KEYS: RemoteKey[] = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "OK",
  "BACK",
  "HOME",
  "PLAY",
  "PAUSE",
];

export function isRemoteKey(k: string): k is RemoteKey {
  return (REMOTE_KEYS as readonly string[]).includes(k);
}
