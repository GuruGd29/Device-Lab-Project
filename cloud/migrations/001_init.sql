-- Device Lab Phase 1 — registry schema (spec §4).
-- The registry is the SOURCE OF TRUTH and lives in the cloud plane, NOT the lab box:
-- a lab-box restart must not wipe the device map.

-- Physical slots decouple stable rack positions from transient devices.
-- Reassigning hardware updates which device occupies a slot; bindings ride the slot.
CREATE TABLE IF NOT EXISTS slots (
  slot_id        TEXT PRIMARY KEY,         -- e.g. "rack-A/pos-03"
  rack_position  TEXT NOT NULL,
  host_agent_id  TEXT NOT NULL             -- which lab agent owns this slot
);

-- Lab agents that have connected. sfu_signaling_url is how the dashboard reaches the SFU.
CREATE TABLE IF NOT EXISTS agents (
  agent_id           TEXT PRIMARY KEY,
  hostname           TEXT,
  sfu_signaling_url  TEXT NOT NULL,
  version            TEXT,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected          BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS cameras (
  camera_id          TEXT PRIMARY KEY,      -- stable id reported by the capture app
  slot_id            TEXT REFERENCES slots(slot_id),
  host_agent_id      TEXT NOT NULL,
  sfu_publish_track  TEXT,                  -- track/producer id on the SFU
  status             TEXT NOT NULL DEFAULT 'offline'
                       CHECK (status IN ('online', 'offline', 'unhealthy')),
  last_heartbeat_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tvs (
  tv_id              TEXT PRIMARY KEY,
  platform           TEXT NOT NULL CHECK (platform IN ('tizen', 'webos', 'androidtv')),
  serial             TEXT,
  firmware_version   TEXT,                  -- protocols are firmware-dependent; store it
  slot_id            TEXT REFERENCES slots(slot_id),
  rack_position      TEXT,
  net_ip             TEXT,
  mac                TEXT,
  vlan               TEXT,
  control_protocol   TEXT NOT NULL
                       CHECK (control_protocol IN ('samsung_ws', 'lg_ssap', 'androidtv_remote')),
  control_secret_ref TEXT,                  -- pointer to stored token/key/cert (NOT the secret inline)
  host_agent_id      TEXT NOT NULL,
  -- `status` is the EFFECTIVE status the cloud computes (binding + camera + reservation +
  -- heartbeat). `agent_status` is the raw control-session signal the lab agent reports;
  -- the state machine folds it in. Keeping them separate keeps the cloud authoritative.
  status             TEXT NOT NULL DEFAULT 'provisioning'
                       CHECK (status IN ('free','in_use','offline','no_camera','unhealthy','provisioning')),
  agent_status       TEXT,
  last_heartbeat_at  TIMESTAMPTZ
);

-- The mutable link. One row per bound TV. Deleting = unassign. 1:1 this phase.
CREATE TABLE IF NOT EXISTS bindings (
  tv_id              TEXT PRIMARY KEY REFERENCES tvs(tv_id) ON DELETE CASCADE,
  camera_id          TEXT UNIQUE REFERENCES cameras(camera_id) ON DELETE CASCADE,
  method             TEXT NOT NULL CHECK (method IN ('qr_handshake', 'manual_confirm')),
  confidence         REAL,                  -- 1.0 for QR match, null/manual otherwise
  bound_by           TEXT,                  -- user who confirmed
  last_verified_at   TIMESTAMPTZ
);

-- Exclusive reservation lock. Short renewed lease + hard ceiling (spec §7).
CREATE TABLE IF NOT EXISTS reservations (
  tv_id            TEXT PRIMARY KEY REFERENCES tvs(tv_id) ON DELETE CASCADE,
  held_by          TEXT NOT NULL,           -- user id
  session_id       TEXT NOT NULL,           -- ties lock to a session, not a socket
  acquired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  lock_expires_at  TIMESTAMPTZ NOT NULL,    -- renewed every heartbeat (the short lease)
  hard_expires_at  TIMESTAMPTZ NOT NULL     -- max session window (e.g. +40 min), not renewed
);

-- Dashboard users. role gates admin-only actions (force-release, recalibrate).
CREATE TABLE IF NOT EXISTS users (
  user_id        TEXT PRIMARY KEY,
  username       TEXT UNIQUE NOT NULL,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,            -- scrypt; see auth.ts
  role           TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'admin')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tvs_status ON tvs (status);
CREATE INDEX IF NOT EXISTS idx_tvs_host ON tvs (host_agent_id);
CREATE INDEX IF NOT EXISTS idx_cameras_status ON cameras (status);
CREATE INDEX IF NOT EXISTS idx_cameras_host ON cameras (host_agent_id);
CREATE INDEX IF NOT EXISTS idx_reservations_lock_expiry ON reservations (lock_expires_at);
