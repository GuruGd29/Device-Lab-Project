#!/usr/bin/env bash
# End-to-end Definition-of-Done smoke (spec §13) over the REST API the dashboard uses.
# Assumes the cloud plane (:8080) and a lab agent (DEV_SIMULATE recommended) are ALREADY
# running with the two sim TVs registered. Exits non-zero on the first failed assertion.
#
#   ./scripts/e2e-smoke.sh                 # against http://localhost:8080
#   API=http://host:8080 ./scripts/e2e-smoke.sh
set -euo pipefail
API="${API:-http://localhost:8080}"
TV1="${TV1:-tv-sim-samsung-01}"
TV2="${TV2:-tv-sim-lg-02}"

j() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; exit 1; }

login() { curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$1\",\"password\":\"$2\"}" | j "d['token']"; }

echo "== auth =="
TOKEN=$(login operator operator); ATOKEN=$(login admin admin)
[ -n "$TOKEN" ] && [ -n "$ATOKEN" ] && pass "operator + admin logged in" || fail "login"

A() { echo "authorization: Bearer $1"; }

echo "== calibrate (QR handshake) =="
for TV in "$TV1" "$TV2"; do
  ST=$(curl -s -X POST "$API/tvs/$TV/calibrate" -H "$(A "$TOKEN")" | j "d['status']")
  [ "$ST" = "bound" ] && pass "$TV bound" || fail "$TV calibrate -> $ST"
done

echo "== reserve + exclusivity =="
RES=$(curl -s -X POST "$API/tvs/$TV1/reserve" -H "$(A "$TOKEN")")
SID=$(echo "$RES" | j "d['session_id']")
[ -n "$SID" ] && pass "operator holds $TV1" || fail "reserve: $RES"

CODE=$(curl -s -o /tmp/_c.json -w '%{http_code}' -X POST "$API/tvs/$TV1/reserve" -H "$(A "$ATOKEN")")
HELD=$(j "d['held_by']" </tmp/_c.json)
[ "$CODE" = "409" ] && [ "$HELD" = "u-operator" ] && pass "2nd user blocked (409, held_by $HELD)" || fail "expected 409 held_by operator, got $CODE $(cat /tmp/_c.json)"

echo "== holder-validated control =="
OK=$(curl -s -X POST "$API/tvs/$TV1/key" -H "$(A "$TOKEN")" -H 'content-type: application/json' -d "{\"session_id\":\"$SID\",\"key\":\"OK\"}" | j "d['ok']")
[ "$OK" = "True" ] && pass "holder key press ok" || fail "holder key press"

CODE=$(curl -s -o /tmp/_k.json -w '%{http_code}' -X POST "$API/tvs/$TV1/key" -H "$(A "$ATOKEN")" -H 'content-type: application/json' -d '{"session_id":"bogus","key":"OK"}')
[ "$CODE" = "403" ] && pass "non-holder key press -> 403" || fail "expected 403, got $CODE"

echo "== stream resolution =="
TRACK=$(curl -s "$API/tvs/$TV1/stream" -H "$(A "$TOKEN")" | j "d.get('sfu_track')")
[ -n "$TRACK" ] && [ "$TRACK" != "None" ] && pass "stream resolves to $TRACK" || fail "stream resolution"

echo "== release paths =="
curl -s -X POST "$API/tvs/$TV1/force-release" -H "$(A "$ATOKEN")" >/dev/null && pass "admin force-release"
LRES=$(curl -s -X POST "$API/tvs/$TV2/reserve" -H "$(A "$TOKEN")"); LSID=$(echo "$LRES" | j "d['session_id']")
REL=$(curl -s -X POST "$API/tvs/$TV2/release" -H "$(A "$TOKEN")" -H 'content-type: application/json' -d "{\"session_id\":\"$LSID\"}" | j "d['ok']")
[ "$REL" = "True" ] && pass "explicit self-release" || fail "release"

echo "ALL E2E CHECKS PASSED ✓"
