-- Operator/cloud-owned TV metadata. These columns are NEVER written by agent upserts
-- (registerDevices/applyHeartbeat) — the COALESCE-preserve invariant keeps operator edits
-- from being clobbered by the next agent report. All additive + idempotent.

ALTER TABLE tvs ADD COLUMN IF NOT EXISTS custom_name TEXT;        -- operator-friendly display name
ALTER TABLE tvs ADD COLUMN IF NOT EXISTS model       TEXT;        -- e.g. "TCL Smart TV"
ALTER TABLE tvs ADD COLUMN IF NOT EXISTS brand       TEXT;        -- e.g. "TCL"
ALTER TABLE tvs ADD COLUMN IF NOT EXISTS location    TEXT;        -- free-text rack/room location
ALTER TABLE tvs ADD COLUMN IF NOT EXISTS disabled    BOOLEAN NOT NULL DEFAULT false; -- maintenance flag; forces testable=false

-- Provenance: 'agent' = reported by a lab agent; 'declared' = added from the dashboard and not
-- yet claimed by an agent (status stays 'provisioning' until an agent registers the same tv_id).
ALTER TABLE tvs ADD COLUMN IF NOT EXISTS origin      TEXT NOT NULL DEFAULT 'agent'
                                          CHECK (origin IN ('declared', 'agent'));
ALTER TABLE tvs ADD COLUMN IF NOT EXISTS declared_by TEXT;        -- user who added it
ALTER TABLE tvs ADD COLUMN IF NOT EXISTS declared_at TIMESTAMPTZ;
