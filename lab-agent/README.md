# Lab Controller Agent

The Device Lab Phase 1 **Lab Controller Agent** (spec §3, component 2). Python 3.11+ / asyncio.

It is the only component that touches real TVs and the SFU. It connects **out** to the cloud
control plane's `/agent` WebSocket (the cloud is never in the media path), holds the persistent
vendor control sessions for each TV (Samsung Tizen / LG webOS / Android TV), runs a **local SFU**
(WHIP ingest + WebRTC subscribe), scans camera feeds for the calibration QR, and reports
device/camera health up via heartbeats. **Media stays local** (spec §3): the phone publishes to
this agent's SFU and the agent relays the track to the dashboard; the cloud only relays signaling
JSON.

## What it speaks

All framing mirrors `packages/contracts/src/agent-protocol.ts` (validated, when present, against
`packages/contracts/schemas/agent-protocol.schema.json`):

| Direction | Messages |
|-----------|----------|
| Agent → Cloud | `agent.hello`, `agent.register_devices`, `agent.heartbeat`, `calibration.result`, `key.ack`, `signal.answer`, `signal.candidate` |
| Cloud → Agent | `agent.welcome`, `calibrate.start`, `calibrate.clear`, `key.press`, `stream.request`, `stream.teardown`, `signal.offer`, `signal.candidate`, `tv.connect`, `tv.disconnect` |

On connect it sends `agent.hello` (with `shared_secret` + `host{sfu_signaling_url, version,
hostname}`); on `agent.welcome` it sends `agent.register_devices` then heartbeats every
`heartbeat_interval_seconds`. It reconnects with exponential backoff + jitter; tokens/keys
persist in the adapters so reconnects are silent (spec §14).

## Install

```bash
cd lab-agent
python3.11 -m venv .venv && . .venv/bin/activate
pip install -e .            # DEV_SIMULATE path — light, self-contained wheels only
# On the real lab box, also pull the hardware deps (vendor SDKs + pyzbar/libzbar):
pip install -e ".[hardware]"
```

Core deps (`websockets`, `aiohttp`, `aiortc`, `numpy`, `pyyaml`, `jsonschema`,
`opencv-python-headless`, `segno`) all ship self-contained wheels and need **no system libs** —
so DEV_SIMULATE works on a bare laptop. The `[hardware]` extra adds `pyzbar` (needs `libzbar`),
`samsungtvws`, `aiowebostv`, and `androidtvremote2`; the vendor SDKs are imported lazily so the
sim path never loads them.

## Run — dev simulation (no hardware)

```bash
cp .env.example .env        # DEV_SIMULATE=1 by default; SFU on http://0.0.0.0:7000
# macOS note: AirPlay Receiver squats on :7000 — set SFU_SIGNALING_URL to a free port.
DEV_SIMULATE=1 SFU_SIGNALING_URL=http://127.0.0.1:7001 device-lab-agent
```

With the cloud plane running (`http://localhost:8080`) the agent will:
connect → register **two fake TVs** (a Tizen + a webOS) and **two cameras** → heartbeat →
answer a `calibrate.start` by "seeing" the QR on the matching simulated camera
(`calibration.result matched=true, confidence=1.0`) → ack key presses → serve a synthetic video
track to any WebRTC subscriber.

In sim mode the SFU synthesizes a per-camera `VideoStreamTrack` that draws the camera id + a
moving clock, and — when that camera's bound TV is "rendering" a calibration QR — draws a **real,
decodable QR** for the payload, so the QR handshake genuinely succeeds end-to-end with no
hardware. (The synthetic QR is pinned to version ≥ 2 because `cv2.QRCodeDetector`, the
light-path decoder, is unreliable on version-1 codes.)

Drop a `devices.yaml` in place to simulate a specific inventory instead of the built-in fakes.

## Run — real hardware

1. Put the agent box **on the TV subnet** (spec §14: Samsung blocks cross-subnet WebSocket).
2. `cp devices.example.yaml devices.yaml` and fill in your TVs + cameras. Each TV's
   `control_secret_ref` points at the stored, already-paired secret (never inline):
   - Samsung (`samsung_ws`): a dir holding `token.txt` (samsungtvws writes/reuses it).
   - LG (`lg_ssap`): a dir holding `client_key.txt`.
   - Android TV (`androidtv_remote`): a dir holding `cert.pem` + `key.pem`.
3. `cp .env.example .env`, set `DEV_SIMULATE=` (empty/unset), `AGENT_SHARED_SECRET` (must match
   the cloud), and `SFU_SIGNALING_URL` to a host:port the **dashboards can reach** (e.g.
   `http://10.0.0.5:7000`, not `0.0.0.0`).
4. `pip install -e ".[hardware]"` then `device-lab-agent`.

The mounted Android capture phone publishes to the SFU with a WHIP `POST /whip/{camera_id}`
(SDP offer in, SDP answer out, `201 Created`) and reports liveness with
`POST /camera/{camera_id}/heartbeat`. `DELETE /whip/{camera_id}` stops a publication.

### Calibration per platform (spec §5)

Samsung and LG render the QR by pointing the TV browser at the agent's own
`GET /calibration?payload=<tv_id>` page (fullscreen QR). **Android TV** cannot launch a URL over
the remote v2 protocol — `render_qr` falls back to an ADB `am start` VIEW intent **only if
`ADB_PATH` is set** (adb-over-network must be authorized on the TV); otherwise it raises and
calibration must use the dashboard's **manual_confirm** fallback.

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `CLOUD_WS_URL` | `ws://localhost:8080/agent` | cloud control tunnel |
| `AGENT_ID` | `lab-agent-01` | this agent's id |
| `AGENT_SHARED_SECRET` | `dev-agent-secret` | must match the cloud |
| `SFU_SIGNALING_URL` | `http://0.0.0.0:7000` | advertised + bind addr for the local SFU |
| `DEVICES_YAML` | `<repo>/lab-agent/devices.yaml` | device inventory path |
| `DEV_SIMULATE` | unset | `1` ⇒ no hardware, synthetic feeds |
| `CALIBRATION_TIMEOUT_SECONDS` | `20` | QR scan window |
| `RECONNECT_MIN/MAX_SECONDS` | `1` / `30` | tunnel backoff bounds |
| `ADB_PATH` | unset | enables Android TV URL-launch calibration |
| `LOG_LEVEL` | `INFO` | logging verbosity |

## Layout

```
device_lab_agent/
  __main__.py      console entry: wire config → adapters → SFU → cloud tunnel; run forever
  config.py        env + devices.yaml loading; built-in sim inventory
  protocol.py      AgentToCloud/CloudToAgent builders + parser + optional schema validation
  cloud_client.py  asyncio websockets client: hello/welcome/register/heartbeat + dispatch + backoff
  app.py           AgentApp — the handler core; builds frames, routes inbound to adapters/SFU
  sfu.py           local media plane: WHIP ingest, subscribe (MediaRelay), sim tracks, calib page
  calibration.py   QR handshake: render → scan every camera → first match wins
  adapters/        TvAdapter ABC + samsung / lg / androidtv / simulator + normalized keymap
```

## Verify

```bash
python -m py_compile $(find device_lab_agent -name '*.py')   # syntax
# end-to-end sim acceptance is exercised by the harness described in the task; the agent connects,
# registers, heartbeats, calibrates matched=true, acks keys, and serves a WebRTC subscriber.
```
