#!/usr/bin/env bash
# Maestro device harness — PRD 3.3 (#1015) and 5.4 (#1018), per research #1002.
#
# Runs on an Android emulator (no macOS runner needed). Driven by
# .github/workflows/mobile-maestro.yml, which provides everything below as
# preconditions; it can also be run by hand against a local emulator:
#
#   - an emulator/device on `adb` with the app installed as a DEBUGGABLE build
#     (`run-as` needs it), bundled by Metro with EXPO_PUBLIC_AUTH_MODE=dev so
#     @clerk/clerk-expo is the dev shim (scripts/dev-auth-guard.cjs);
#   - Metro on :8081 reachable from the device (`adb reverse tcp:8081 tcp:8081`
#     — adb transport, so airplane mode does NOT cut the JS bundle);
#   - the API on $API_URL (host side) in DEV_AUTH_BYPASS mode (NODE_ENV=dev)
#     against real Postgres at $DATABASE_URL, reached by the app at
#     http://10.0.2.2:<port> (emulator network — airplane mode DOES cut it);
#   - `maestro`, `psql`, `node`, `curl` on PATH.
#
# What each PRD 5.4 clause is proven by (research #1002's mapping):
#   1 journal flushes on reconnect   → flow C (banner clears) + check_flushed
#   2 same key → one row             → the key read from the on-device journal
#                                      in A equals the one after the crash (B),
#                                      and exactly one voice_recordings row
#                                      carries it (real Postgres)
#   3 crash re-enqueues              → flow B kills the process while queued;
#                                      the item comes back with the same key
#                                      (the mid-flush kill window is NOT covered)
#   4 audio deleted only on confirmed flush → audio present after A and B,
#                                      gone after C
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
: "${DATABASE_URL:?DATABASE_URL must point at the Postgres the API writes to}"
FLOWS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.maestro" && pwd)"
OUT="${MAESTRO_OUT:-$PWD/maestro-out}"
mkdir -p "$OUT"
EVIDENCE="$OUT/evidence.txt"
: >"$EVIDENCE"

log() { echo "[maestro-device-run] $*" | tee -a "$EVIDENCE"; }
fail() { log "FAIL: $*"; exit 1; }

# On any failure, leave what is needed to diagnose it next to the Maestro
# debug output: the device log tail and the screen the app was left on.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    adb logcat -d 2>/dev/null | tail -n 4000 >"$OUT/logcat-tail.txt" || true
    adb exec-out screencap -p >"$OUT/final-screen.png" 2>/dev/null || true
    log "exit $rc — logcat tail + final screen written to $OUT"
  fi
}
trap on_exit EXIT

# The debug build loads its JS from Metro. Request the exact bundle the app
# asks for ONCE, up front: a Babel/transform error then fails here in seconds
# with Metro's own message, instead of as a red box behind a 2-minute Maestro
# wait (run 36765536371). It also warms Metro's cache for the first launch.
BUNDLE_URL='http://localhost:8081/.expo/.virtual-metro-entry.bundle?platform=android&dev=true&lazy=true&minify=false&app=com.serviceos.app&modulesOnly=false&runModule=true&excludeSource=true&sourcePaths=url-server'
check_bundle() {
  local code
  log "requesting the Android dev bundle from Metro"
  code="$(curl -sS --max-time 900 -o "$OUT/bundle-check.txt" -w '%{http_code}' "$BUNDLE_URL" || echo 000)"
  if [ "$code" != "200" ]; then
    head -c 4000 "$OUT/bundle-check.txt" 2>/dev/null | tee -a "$EVIDENCE" || true
    echo | tee -a "$EVIDENCE"
    fail "Metro returned HTTP $code for the Android bundle"
  fi
  log "bundle OK ($(wc -c <"$OUT/bundle-check.txt") bytes)"
  rm -f "$OUT/bundle-check.txt"
}

# --- dev-auth token: byte-identical to src/dev/clerk-expo-dev-shim.tsx's -----
b64url() { printf '%s' "$1" | base64 | tr -d '=\n' | tr '/+' '_-'; }
TOKEN="$(b64url '{"alg":"none","typ":"JWT"}').$(b64url '{"sub":"dev_owner","sid":"dev-session","role":"owner"}').x"

api_post() {
  curl -fsS -X POST "$API_URL$1" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2"
}
json_get() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(v[process.argv[1]]??(v.data??{})[process.argv[1]]??"")})' "$1"; }

# --- seed the 3.3 booking prerequisites through the real API ----------------
CUSTOMER_FIRST="Maestro"
CUSTOMER_LAST="Defaults"
JOB_SUMMARY="Maestro defaults visit"
log "seeding customer/location/job for the dev-auth tenant via $API_URL"
CUSTOMER_ID="$(api_post /api/customers "{\"firstName\":\"$CUSTOMER_FIRST\",\"lastName\":\"$CUSTOMER_LAST\",\"primaryPhone\":\"+15555550133\"}" | json_get id)"
[ -n "$CUSTOMER_ID" ] || fail "customer seed returned no id"
LOCATION_ID="$(api_post /api/locations "{\"customerId\":\"$CUSTOMER_ID\",\"street1\":\"1 Emulator Way\",\"city\":\"Testville\",\"state\":\"CA\",\"postalCode\":\"90001\"}" | json_get id)"
[ -n "$LOCATION_ID" ] || fail "location seed returned no id"
api_post /api/jobs "{\"customerId\":\"$CUSTOMER_ID\",\"locationId\":\"$LOCATION_ID\",\"summary\":\"$JOB_SUMMARY\",\"priority\":\"normal\"}" >/dev/null

run_flow() {
  local flow="$1"; shift
  log "maestro test $flow"
  (cd "$OUT" && maestro test --format junit --output "$OUT/${flow%.yaml}.xml" --debug-output "$OUT/debug/${flow%.yaml}" "$FLOWS/$flow" "$@")
}

# --- fresh app state -----------------------------------------------------
# `pm clear` wipes the app sandbox (journal, audio, session), then the RN dev
# pref `debug_http_host` is re-seeded so the debug build loads its JS from
# Metro at localhost:8081 over `adb reverse` — adb transport, unaffected by
# airplane mode. (The emulator default, 10.0.2.2:8081, IS cut by airplane mode,
# so the phase-B relaunch could not load the bundle.) Maestro's clearState
# would wipe this pref too, which is why no flow uses it.
PREFS_B64="$(printf '%s' '<?xml version="1.0" encoding="utf-8" standalone="yes" ?><map><string name="debug_http_host">localhost:8081</string></map>' | base64 | tr -d '\n')"
reset_app() {
  adb shell am force-stop com.serviceos.app
  adb shell pm clear com.serviceos.app >/dev/null
  adb shell "run-as com.serviceos.app sh -c 'mkdir -p shared_prefs && echo $PREFS_B64 | base64 -d > shared_prefs/com.serviceos.app_preferences.xml'"
  adb shell pm grant com.serviceos.app android.permission.RECORD_AUDIO || true
}

# --- on-device reads (debuggable build → run-as) ----------------------------
journal() { adb exec-out run-as com.serviceos.app cat files/offline-queue.json 2>/dev/null || echo '{"items":[]}'; }
audio_files() { adb exec-out run-as com.serviceos.app ls files/offline-audio/ 2>/dev/null | tr -d '\r' | grep -v '^$' || true; }
# Emits "<count of not-done items>|<idempotencyKey of the first>|<audio basename of the first>"
journal_summary() {
  # shellcheck disable=SC2016 # JS template literal, not shell expansion
  journal | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{\"items\":[]}");const it=(j.items||[]).filter(i=>i.status!=="done");const f=it[0]||{};const a=((f.payload||{}).audioUri||"").split("/").pop();console.log(`${it.length}|${f.idempotencyKey||""}|${a}`)})'
}

KEY_A=""
AUDIO_A=""
check_offline_queued() {
  local phase="$1" summary count key audio files
  summary="$(journal_summary)"
  IFS='|' read -r count key audio <<<"$summary"
  files="$(audio_files)"
  log "phase $phase journal: $count queued item(s), key=$key, audio=$audio; offline-audio/: $(echo "$files" | tr '\n' ' ')"
  [ "$count" = "1" ] || fail "phase $phase: expected exactly 1 queued item, got $count"
  [ -n "$key" ] || fail "phase $phase: queued item has no idempotency key"
  echo "$files" | grep -qx "$audio" || fail "phase $phase: journaled audio $audio is not on disk"
  if [ "$phase" = "A" ]; then
    KEY_A="$key"; AUDIO_A="$audio"
  else
    [ "$key" = "$KEY_A" ] || fail "phase $phase: idempotency key changed across the crash ($KEY_A → $key)"
    [ "$audio" = "$AUDIO_A" ] || fail "phase $phase: audio file changed across the crash"
  fi
}

check_flushed() {
  local summary count files rows
  summary="$(journal_summary)"
  IFS='|' read -r count _ _ <<<"$summary"
  files="$(audio_files)"
  log "phase C journal: $count not-done item(s); offline-audio/: '$(echo "$files" | tr '\n' ' ')'"
  [ "$count" = "0" ] || fail "phase C: journal still holds $count item(s) after reconnect"
  [ -z "$files" ] || fail "phase C: local audio not deleted after the confirmed flush"
  rows="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM voice_recordings WHERE idempotency_key = '$KEY_A'")"
  log "voice_recordings rows with the journaled key: $rows"
  [ "$rows" = "1" ] || fail "expected exactly one voice_recordings row for the journaled key, got $rows"
}

check_bundle

# --- PRD 3.3 -----------------------------------------------------------------
reset_app
run_flow prd-3.3-defaults-notice.yaml \
  -e MAESTRO_CUSTOMER_NAME="$CUSTOMER_FIRST $CUSTOMER_LAST" -e MAESTRO_JOB_SUMMARY="$JOB_SUMMARY"

# --- PRD 5.4 -----------------------------------------------------------------
reset_app
run_flow prd-5.4-offline-capture.yaml
check_offline_queued "A"
run_flow prd-5.4-crash-relaunch.yaml
check_offline_queued "B"
run_flow prd-5.4-reconnect.yaml
check_flushed

log "PASS — 3.3 notice reached signed in; 5.4 offline → crash → reconnect proven on device"
