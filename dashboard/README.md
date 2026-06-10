# Web Dashboard

The operator-facing UI for Device Lab Phase 1 (spec §10, runtime loop §6). React + TypeScript +
Vite. It is a thin client over the **already-built** cloud control plane — REST for commands,
the `/dashboard` WebSocket for live presence + WebRTC signaling. **No backend mocking**; it talks
to the real cloud on `http://localhost:8080` by default.

## Screens

1. **Login** — `POST /auth/login` → JWT, persisted in `localStorage`, attached as
   `Authorization: Bearer <token>` on every REST call and in the `dashboard.hello` WS frame.
2. **Lab overview** — two pools (TVs + cameras), color-coded live status from WS pushes
   (`free`=green, `in_use`=amber with "In use by … ~Nm left", `offline`/`unhealthy`/`no_camera`=
   red/grey with the reason). TV cards show binding state (camera id + method + confidence). The
   **Test** button is gated client-side: healthy bound camera + TV not offline/unhealthy/
   provisioning + (free or held by you); the block reason shows on hover.
3. **Assign / Calibrate** — QR handshake (`POST /tvs/:id/calibrate`, live progress from
   `calibration.update`), manual assign (`POST /tvs/:id/binding`), unassign
   (`DELETE /tvs/:id/binding`). Re-runnable.
4. **Device view (test)** — reserve the lock (`POST /tvs/:id/reserve`; 409 → "in use by … until
   …", no entry), 15s heartbeat (`POST /tvs/:id/heartbeat`; lost lock → banner + exit), live
   countdowns to `lock_expires_at` + `hard_expires_at`, WebRTC receive-only stream over the WS
   (aggressive jitter buffer, `playoutDelayHint = 0.03`), soft remote (`POST /tvs/:id/key`,
   normalized keymap) with physical arrow/Enter bindings, End session
   (`POST /tvs/:id/release` + `stream.unsubscribe` + close PC + stop heartbeat; also on
   unmount/tab close).
5. **Admin** (only when `user.role === "admin"`) — force-release a stuck lock
   (`POST /tvs/:id/force-release`); recalibration is the same Assign/Calibrate flow.

## Run (dev)

The cloud control plane must be up first (see `cloud/README.md`):

```bash
# from the repo root
docker compose up -d db nats
npm install                       # links this workspace
npm run -w @device-lab/contracts build
npm run -w cloud migrate && npm run -w cloud seed
npm run -w cloud dev              # http://localhost:8080

# then, in another shell, from the repo root:
npm run -w dashboard dev          # http://localhost:5173
```

Sign in with a dev user: `operator / operator` or `admin / admin`.

### Config

- `VITE_API_URL` (default `http://localhost:8080`) — base URL of the cloud control plane. The
  dashboard WS URL is derived from it (`http`→`ws`, `https`→`wss`, path `/dashboard`). Copy
  `.env.example` to `.env` to override.

## Build / verify

```bash
# from the repo root
npm install
npm run -w dashboard build        # tsc -b && vite build — must complete with no type errors
```

## Notes / caveats

- **Media never traverses the cloud** (spec §3): the WS carries control + WebRTC signaling JSON
  only; the actual video flows phone → SFU (lab box) → browser over the local link. The dashboard
  is a pure `recvonly` consumer (`addTransceiver('video', {direction:'recvonly'})`).
- **No polling** (spec §8): all pool/reservation/calibration state arrives via `pools.snapshot`
  and the `tv.updated` / `camera.updated` / `reservation.updated` / `calibration.update` pushes;
  the store reconciles each. The WS auto-reconnects with backoff and re-syncs from a fresh
  snapshot.
- **Lock-holder validation is server-side** (spec §7/§11): the dashboard's Test gate is a UX
  convenience; the cloud independently rejects non-holder stream subscribes (WS `error`
  `not_holder`) and key presses (`403`). The keypad disables itself on a 403.
- `reservation.updated` frames omit `session_id` (only the holding tab knows its own); the store
  preserves a known `session_id` only while the holder is unchanged.
- `playoutDelayHint` is Chromium-only and `jitterBufferTarget` is the standardized successor;
  both are applied behind feature checks and are best-effort. Use desktop Chrome/Edge (spec §10).
- WebRTC ICE uses a public STUN server for host-candidate gathering; the SFU answer drives the
  actual (local-network) transport, so no TURN relay is needed in Phase 1.
