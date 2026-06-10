# Phase 1 — Device & Camera Orchestration Spec (TVs only)

> Implementation-ready spec for the Phase 1 orchestration layer: a centralized system that
> maps TVs to cameras, lets a tester assign a camera to a TV from the dashboard, watch the
> correct live stream automatically, control the TV over the cloud, and holds an exclusive
> lock so two testers can never share one device. Scope: **TVs only, mounting + one-time TV
> pairing already done.**

## 1. Scope

**In scope:** manage TV devices (Samsung Tizen, LG webOS, Android TV) + camera devices
(mounted Android capture phones) from one dashboard; assign/reassign/unassign a camera to a
TV at runtime (no file edits, no redeploy); calibrate (confirm the camera↔TV binding) once,
self-healing; select a TV → correct live stream appears automatically + soft-remote control
over the cloud; exclusive reservation while one user holds a TV.

**Out of scope (Phase 1):** iOS/Android phones as devices-under-test; HDMI capture-card path;
multi-camera-per-TV; many-watchers-per-TV; reservation queue; automation/CI hook; full
unattended first-time TV provisioning.

**Assumed already true:** TVs rack-mounted, powered, on the lab VLAN/TV subnet; each TV paired
once with its token/client-key/cert stored; one Android capture phone mounted per TV publishing
a stream.

## 2. Core mental model

Two independent pools (cameras = things producing a stream; TVs = things I can send keys to)
plus one mutable link (the binding: `tv_id → camera_id`). Assigning = writing the row;
reassigning = updating it; unassigning = deleting it. Cardinality: strictly **1 camera : 1 TV**,
link kept mutable so it can be repointed. A TV is only **testable** when it has a healthy bound
camera. No binding → controllable but blind → testing blocked.

## 3. Components

1. **Android Capture App** (phone at each TV) — publish one WebRTC stream; report heartbeat;
   render fullscreen QR when asked (calibration aid).
2. **Lab Controller Agent** (Linux box, ON TV subnet) — hold TV control connections
   (samsungtvws / aiowebostv / androidtvremote2), run the SFU, scan camera feeds for QR codes,
   report device/camera health up to the cloud.
3. **Cloud Control Plane** (cloud/VPS) — OWNS the registry (source of truth), auth, assignment +
   reservation APIs, signaling relay. NOT in the media path.
4. **Web Dashboard** (desktop Chrome/Edge) — two-pools view, assign/calibrate UI, device picker,
   live stream, soft remote, session lock UI.

**Critical placement rule:** the registry lives in the cloud plane, NOT the lab box. **Media
stays local:** phone → SFU (lab box) → dashboard over the local/same-metro link. The cloud
tunnel carries control + signaling JSON only. Never hairpin video through the cloud.

## 4. Data model (Postgres)

See `cloud/migrations/001_init.sql`. Tables: `slots`, `cameras`, `tvs`, `bindings` (the mutable
link, 1:1), `reservations` (exclusive lock, short renewed lease + hard ceiling), plus `agents`
and `users`. Fields people forget: `slot_id`, `host_agent_id`, `control_secret_ref`,
`firmware_version`, and the status/heartbeat/reservation trio.

## 5. Calibration — confirming the camera↔TV binding

**QR handshake (recommended):** operator clicks Calibrate → cloud → agent pushes the TV's
`tv_id` as a fullscreen QR/AprilTag onto THAT TV's own screen (via its control channel) → agent
scans every camera feed → the camera that SEES `tv_id`'s code is bound automatically
(`method=qr_handshake, confidence=1.0`) → clear the QR. Self-healing: swap two phones, re-run,
the map corrects itself.

**Manual confirm (fallback):** dashboard shows a camera feed; operator confirms "this camera
shows TV-X" (`method=manual_confirm`). Use only when QR can't render on a given TV.

**Recalibration triggers:** camera offline→returns under a different slot; operator request;
`last_verified_at` older than threshold → dashboard nudges.

## 6. Runtime loop — "select a TV, test it over the cloud"

1. **RESOLVE** registry: `tv_id → bindings.camera_id → cameras.sfu_publish_track` (block if no
   binding or camera unhealthy — show why).
2. **RESERVE** atomic claim of the exclusive lock (§7). Fail → show holder + ETA.
3. **STREAM** dashboard subscribes to the SFU track; aggressive jitter buffer
   (playoutDelay ~30–40ms). Video rides the LOCAL link, not the cloud.
4. **CONTROL** soft-remote key: Dashboard --WSS--> Cloud --tunnel--> Lab Agent --> TV.
5. **END** explicit End session OR TTL lapse → release lock, tear down media subscription AND
   control channel.

## 7. Exclusive reservation lock (hard requirement)

Two testers on one TV = two control connections fighting one authorized session; the second
breaks the first. The lock protects the device connection itself.

- **Server-side + atomic.** Claiming is ONE DB statement (INSERT … ON CONFLICT … WHERE). Never
  let the dashboard enforce exclusivity.
- **Three release paths:** explicit release; TTL expiry (short `lock_expires_at`, expired lock
  counts as free, auto-stolen); heartbeat + lease renewal (active session pings ~15–30s,
  renews `lock_expires_at`). Use a short renewed lease, not one long 40-min TTL — the 40-min
  figure is `hard_expires_at` (max session window, not renewed).
- **Not-annoying:** show identity ("In use by Ravi, ~22 min left"); reconnect grace (lock tied
  to `session_id`, not a socket — same user's tab reconnecting resumes); admin force-release;
  teardown on release.
- **Lock scope this phase:** exclusive on BOTH control and view.

## 8. Device state machine

Statuses: `free | in_use | offline | no_camera | unhealthy | provisioning`, plus reservation
owner + expiry when `in_use`. Heartbeats from the lab agent drive transitions — don't poll. Use
pub/sub for presence.

## 9. Reconcile loop — orphan handling

| Situation | Correct behavior |
|---|---|
| Camera online, TV offline | binding kept, TV `offline`, not testable, show why |
| TV online, no binding | `no_camera`, controllable but blind, block Test |
| Both online, camera stopped publishing | `unhealthy`, NOT `free` |
| Camera returns under a different slot | flag for recalibration |
| Lock present but session heartbeat dead | TTL lapses → auto-free |

## 10. Dashboard — screens & actions

1. **Lab overview** — TV pool + camera pool, live status; TV cards show binding state + lock
   holder/ETA.
2. **Assign / calibrate** — pick a TV → Calibrate (QR handshake) or Assign camera (manual) →
   confirm. Re-runnable.
3. **Device view (test)** — gated on a healthy binding: live stream + soft remote (per-platform
   keymap normalized to UP/DOWN/LEFT/RIGHT/OK/BACK/HOME/PLAY/PAUSE) + End session. Shows lock
   countdown.
4. **Admin** — force-release a stuck lock; trigger recalibration.

The Test button is disabled unless the TV is `free` (or held by you) AND has a healthy bound
camera.

## 11. API contracts

See `packages/contracts/src/api.ts` and `cloud/README.md`. Every control call validates the
caller is the current lock holder (`session_id` matches the reservation) before touching the TV.

## 12. Build order

1. Registry + pools. 2. Binding (manual, then QR handshake). 3. Runtime loop. 4. Reservation
lock. 5. Reconcile loop + state machine.

## 13. Definition of done

Operator opens the dashboard, sees both pools with live status, assigns/calibrates a camera to a
Samsung AND an LG TV (QR handshake, auto-confirmed), selects each TV and the correct live stream
appears automatically at the latency target, navigates it with the soft remote over the cloud.
While that operator holds a TV, a second user cannot connect — they see "in use by … until …" —
until release or lease lapse. The registry survives a lab-box restart. Video never traverses the
cloud. All control calls are lock-holder-validated.

## 14. Gotchas

- Lab agent MUST be on the TV subnet (Samsung blocks cross-subnet WebSocket).
- Vendor control protocols are reverse-engineered + firmware-dependent — store `firmware_version`,
  budget for per-model quirks.
- Camera is the biggest latency offender (~100ms); if glass-to-glass >300ms, suspect the
  camera/preview path first.
- Stored tokens/keys/certs must persist and reconnect silently; never hard-code secrets —
  reference them (`control_secret_ref`).
