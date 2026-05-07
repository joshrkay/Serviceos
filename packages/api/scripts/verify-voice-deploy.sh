#!/usr/bin/env bash
# Layer A — deploy sanity for the voice provider swap.
#
# Confirms the API is reachable, the new tts_voice_id column from
# migration 088 exists, and (if DATABASE_URL is set) prints the column
# definition so you can verify the schema landed.
#
# Usage:
#   API_URL=https://serviceos-api-production.up.railway.app \
#   DATABASE_URL='postgres://...' \
#     bash packages/api/scripts/verify-voice-deploy.sh
#
# DATABASE_URL is optional. Without it the script skips the SQL check
# and reminds you to run it manually from Railway's Postgres console.
set -euo pipefail

API_URL="${API_URL:-}"
if [ -z "$API_URL" ]; then
  echo "✗ API_URL not set. Example:" >&2
  echo "    API_URL=https://your-api.up.railway.app bash $0" >&2
  exit 1
fi
API_URL="${API_URL%/}"

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

echo "→ Layer A: deploy sanity for $API_URL"
echo

# 1. /health
HEALTH_CODE=$(curl -sS -o /tmp/voice-deploy-health.json -w '%{http_code}' "$API_URL/health" || echo "000")
if [ "$HEALTH_CODE" = "200" ]; then
  pass "/health → 200"
  cat /tmp/voice-deploy-health.json | head -c 400; echo
else
  fail "/health → $HEALTH_CODE"
  cat /tmp/voice-deploy-health.json 2>/dev/null | head -c 400; echo
  exit 1
fi
echo

# 2. /ready
READY_CODE=$(curl -sS -o /tmp/voice-deploy-ready.json -w '%{http_code}' "$API_URL/ready" || echo "000")
if [ "$READY_CODE" = "200" ]; then
  pass "/ready → 200 (migrations applied, deps healthy)"
elif [ "$READY_CODE" = "503" ]; then
  fail "/ready → 503 (a critical dependency is down — usually DB)"
  cat /tmp/voice-deploy-ready.json 2>/dev/null | head -c 400; echo
  exit 1
else
  fail "/ready → $READY_CODE"
  exit 1
fi
echo

# 3. SQL check for tts_voice_id column (migration 088)
if [ -n "${DATABASE_URL:-}" ]; then
  if ! command -v psql >/dev/null 2>&1; then
    warn "psql not installed locally — skipping SQL check."
    warn "Install with: brew install libpq && brew link --force libpq"
  else
    SQL="SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='tenant_settings' AND column_name='tts_voice_id';"
    ROW=$(psql "$DATABASE_URL" -tA -c "$SQL" || true)
    if [ -n "$ROW" ]; then
      pass "tts_voice_id column present: $ROW"
    else
      fail "tts_voice_id column NOT found — migration 088 did not run"
      fail "Check Railway deploy logs for migration errors"
      exit 1
    fi
  fi
else
  warn "DATABASE_URL not set — skipping SQL check."
  warn "Run this in Railway's Postgres console:"
  echo "    SELECT column_name FROM information_schema.columns"
  echo "    WHERE table_name='tenant_settings' AND column_name='tts_voice_id';"
  warn "Expect one row: tts_voice_id"
fi
echo

# 4. Env var reminder (cannot be automated without a Railway API token)
warn "Manual step — confirm in Railway dashboard → API service → Variables:"
echo "    DEEPGRAM_API_KEY      (set, non-empty)"
echo "    ELEVENLABS_API_KEY    (set, non-empty)"
echo "    TTS_PROVIDER=elevenlabs"
echo "    TWILIO_MEDIA_STREAMS_ENABLED=true"
echo

pass "Layer A complete. Proceed to Layer B (UI smoke in the web app)."
