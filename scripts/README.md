# scripts/

Dev + verification helpers. None are required to run the system — they just make the
no-hardware dev loop one command and provide repeatable end-to-end checks.

| Script | What it does |
|--------|--------------|
| `dev-up.sh` | Boots the cloud plane (:8080) + a DEV_SIMULATE lab agent (two fake TVs/cameras). Run the dashboard separately. Ctrl-C tears down. |
| `e2e-smoke.sh` | Drives the full Definition-of-Done flow (spec §13) over REST: login → calibrate (QR) → reserve → exclusivity (2nd user 409) → holder-validated key (non-holder 403) → stream resolve → release paths. Exits non-zero on the first failure. Assumes the stack is already up. |
| `dash_media_test.py` | Headless "dashboard" (aiortc) that reserves a TV, subscribes, exchanges SDP **through the cloud signaling relay**, and decodes a real video frame from the agent's SFU — proving the media path. Run with the lab-agent venv: `lab-agent/.venv/bin/python scripts/dash_media_test.py`. |

Typical loop:

```bash
docker compose up -d db          # or a local Postgres
./scripts/dev-up.sh              # terminal 1 (cloud + sim agent)
npm run -w dashboard dev         # terminal 2 (dashboard at :5173)
./scripts/e2e-smoke.sh           # terminal 3 (assert the whole flow)
```
