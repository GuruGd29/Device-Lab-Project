# Device Lab — Phase 1 (TV & Camera Orchestration)

Centralized orchestration for a rack of TVs and the capture phones pointed at them. A tester
opens the dashboard, **assigns/calibrates** a camera to a TV, selects the TV, the **correct live
stream appears automatically**, and they drive the TV with a soft remote **over the cloud** —
while an **exclusive lock** guarantees no two testers ever share one device.

This repo implements the spec in `03-PHASE1-ORCHESTRATION-SPEC.md`. Scope is deliberately narrow:
**TVs only** (Samsung Tizen, LG webOS, Android TV); physical mounting and one-time pairing are
assumed done.

---

## Architecture (the one idea everything hangs on)

Two independent pools — **cameras** (things producing a stream) and **TVs** (things I can send
keys to) — plus **one mutable link** (`bindings`). Assigning = writing the row, reassigning =
updating it, unassigning = deleting it.

```
  Android Capture App (phone at each TV)         Web Dashboard (desktop Chrome/Edge)
      │ WebRTC publish + heartbeat                    │ assign/calibrate, stream, soft remote, lock UI
      ▼                                               │
  ┌─────────────────────────────┐   control+signaling │   control+signaling (WSS)
  │  Lab Controller Agent        │◄── (JSON only) ─────┼──────────────┐
  │  (Linux box, ON TV SUBNET)   │                     ▼              │
  │  · samsungtvws/aiowebostv/   │            ┌──────────────────────┴───────────┐
  │    androidtvremote2 adapters │            │  Cloud Control Plane (VPS)         │
  │  · SFU (media stays LOCAL)   │── tunnel ──│  · OWNS the registry (Postgres)    │
  │  · QR scan across feeds      │   (WSS)    │  · auth, assignment + reservation  │
  │  · health heartbeats         │            │  · signaling relay (NOT media path)│
  └─────────────────────────────┘            └────────────────────────────────────┘

  MEDIA PATH:  phone → SFU (lab box) → dashboard      (local / same-metro, NEVER the cloud)
  CONTROL/SIGNALING PATH: dashboard ↔ cloud ↔ agent   (JSON only)
```

**Critical placement rule:** the registry lives in the **cloud plane**, not the lab box — a
lab-box restart must not wipe the device map. **Media never traverses the cloud.**

---

## Components

| Dir | Component | Language | Job |
|-----|-----------|----------|-----|
| [`cloud/`](cloud/) | Cloud Control Plane | TypeScript / Fastify | Source-of-truth registry, auth, assignment + **atomic reservation lock**, signaling relay, reconcile loop, state machine |
| [`dashboard/`](dashboard/) | Web Dashboard | React / TS / Vite | Two-pools view, assign/calibrate, live stream + soft remote, lock UI, admin |
| [`lab-agent/`](lab-agent/) | Lab Controller Agent | Python / asyncio | Holds TV control connections, runs SFU, scans feeds for QR, reports health |
| [`android-capture/`](android-capture/) | Android Capture App | Kotlin | Publishes one WebRTC stream, heartbeats, renders fullscreen QR on calibrate |
| [`packages/contracts/`](packages/contracts/) | Shared contracts | TS + JSON Schema | Domain types, REST contracts, agent WS protocol, normalized keymap — the single source the whole system agrees on |

---

## Quick start (dev, no hardware required)

```bash
# 0. Postgres (docker, or a local install — create role/db 'devicelab')
docker compose up -d db nats

# 1. Install TS workspaces + the Python lab-agent venv
npm install
( cd lab-agent && python3 -m venv .venv && . .venv/bin/activate && pip install -e . )

# 2. Boot cloud plane + a DEV_SIMULATE lab agent (two fake TVs/cameras) in one command
./scripts/dev-up.sh             # cloud http://localhost:8080  (Ctrl-C to stop)

# 3. Dashboard (separate terminal)
npm run -w dashboard dev        # http://localhost:5173   (sign in operator/operator)

# 4. Prove the whole flow end-to-end (separate terminal)
./scripts/e2e-smoke.sh          # login → calibrate → reserve → 409 → key/403 → release
lab-agent/.venv/bin/python scripts/dash_media_test.py   # decodes a real video frame via the relay
```

Then open the dashboard, watch the two pools populate, calibrate a TV, reserve it, and drive the
soft remote. See [`cloud/README.md`](cloud/README.md), [`lab-agent/README.md`](lab-agent/README.md),
[`dashboard/README.md`](dashboard/README.md), and [`scripts/README.md`](scripts/README.md).

### Verified end-to-end

The DoD flow (spec §13) is proven over the real stack (cloud + lab agent, no hardware):

- **31 cloud tests pass** against real Postgres — incl. the lock racing **25 users for one TV →
  exactly one wins**, TTL steal, lease renewal, hard ceiling, reconnect-grace, and the §8/§9
  state-machine transitions (`cloud/test/`, run `docker compose up -d db && npm run -w cloud test`).
- **`scripts/e2e-smoke.sh`** drives register → QR-calibrate (auto-bind, confidence 1.0) → reserve
  → a **second user gets 409 "in use by …"** → holder key press ok, **non-holder key press 403** →
  stream resolves → admin force-release + explicit release.
- **`scripts/dash_media_test.py`** decodes a live **640×480 video frame** through the cloud
  signaling relay + the agent's local SFU — media never touches the cloud.
- Dashboard builds clean (`tsc -b && vite build`); lab agent boots, connects, calibrates, acks
  keys, and serves WebRTC in DEV_SIMULATE; Android app verified against the real WebRTC/zxing
  artifacts (needs Android Studio to compile).

### Connecting real devices
- Put the **lab agent on the TV subnet** (Samsung blocks cross-subnet WebSocket).
- Provide per-TV control secrets via `lab-agent/devices.yaml` (`control_secret_ref` → token/key/cert).
- Install the Android capture app on each mounted phone, point it at the lab agent's SFU.
- Unset `DEV_SIMULATE`. The agent discovers/loads configured TVs and cameras and reports them up.

---

## Build order (mirrors spec §12)

1. **Registry + pools** — schema, agent reporting devices up, dashboard pool view. ✅
2. **Binding** — manual assign, then QR-handshake calibration. ✅
3. **Runtime loop** — select → resolve → subscribe to stream → soft-remote keys. ✅
4. **Reservation lock** — atomic acquire, heartbeat lease, three release paths, holder UI, force-release. ✅
5. **Reconcile loop** — orphan/health handling + full state machine. ✅

## Definition of done (spec §13)

Operator opens the dashboard → sees both pools with live status → calibrates a camera to a Samsung
**and** an LG TV (QR handshake, auto-confirmed) → selects each TV and the **correct stream appears
automatically** → drives it with the soft remote over the cloud. While they hold a TV, a second user
**cannot connect** ("in use by … until …") until release **or lease lapse**. The registry survives a
lab-box restart. Video never traverses the cloud. **All control calls are lock-holder validated.**
# Device-Lab-Project
