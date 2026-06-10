#!/usr/bin/env bash
# Boot the dev stack with NO hardware: cloud control plane (:8080) + lab agent in
# DEV_SIMULATE (two fake TVs + cameras). Run the dashboard separately
# (`npm run -w dashboard dev`). Ctrl-C tears everything down.
#
# Prereqs: Postgres reachable at DATABASE_URL, `npm install` done, and the lab-agent venv
# set up (cd lab-agent && python -m venv .venv && . .venv/bin/activate && pip install -e .).
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-postgres://devicelab:devicelab@localhost:5432/devicelab}"
export JWT_SECRET="${JWT_SECRET:-dev-jwt-secret}"
export AGENT_SHARED_SECRET="${AGENT_SHARED_SECRET:-dev-agent-secret}"
export PORT="${PORT:-8080}"
export RUN_MIGRATIONS=1
SFU_PORT="${SFU_PORT:-7011}"   # avoid macOS AirPlay on :7000

AGENT_PY="lab-agent/.venv/bin/device-lab-agent"
[ -x "$AGENT_PY" ] || { echo "lab-agent venv missing — see prereqs in this script's header"; exit 1; }

pids=()
cleanup() { echo; echo "stopping..."; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "migrate + seed..."
npm run -w cloud migrate >/dev/null 2>&1
npm run -w cloud seed >/dev/null 2>&1

echo "starting cloud plane on :$PORT ..."
npx tsx cloud/src/index.ts & pids+=($!)
for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

echo "starting lab agent (DEV_SIMULATE, SFU :$SFU_PORT) ..."
DEV_SIMULATE=1 SFU_SIGNALING_URL="http://127.0.0.1:$SFU_PORT" CLOUD_WS_URL="ws://localhost:$PORT/agent" \
  "$AGENT_PY" & pids+=($!)

echo
echo "Stack up. Cloud http://localhost:$PORT  ·  dashboard: npm run -w dashboard dev (:5173)"
echo "Smoke test: ./scripts/e2e-smoke.sh    ·    Ctrl-C to stop."
wait
