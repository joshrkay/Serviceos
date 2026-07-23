#!/usr/bin/env bash
# Run operator voice top-50 against production API (RS256 Clerk serviceos JWT).
#
# Production Clerk blocks Backend API session minting (dev-only). Two paths:
#   A) Browser JWT (recommended):
#      Sign in on app.therivetapp.com → copy serviceos JWT → .tmp-prod-serviceos.jwt
#      ./scripts/run-production-operator-voice-50.sh v3 --jwt-file .tmp-prod-serviceos.jwt
#   B) sk_live_ secret (auth probe only — session mint fails on production):
#      CLERK_SECRET_KEY=sk_live_… ./scripts/run-production-operator-voice-50.sh v3
#
# Optional fixture seed (requires production Postgres):
#   PROD_DATABASE_URL=postgres://… \
#   QA_TENANT_ID=… QA_ACTOR_ID=… \
#   ALLOW_OPERATOR_VOICE_FIXTURE_SEED_OUTSIDE_DEVELOPMENT=true \
#   ./scripts/run-production-operator-voice-50.sh v3 --seed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORPUS="${1:-v3}"
JWT_FILE=""
MODE=""
EXTRA_ARGS=()

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jwt-file)
      JWT_FILE="${2:-.tmp-prod-serviceos.jwt}"
      shift 2 || true
      ;;
    --seed)
      MODE="--seed"
      shift
      ;;
    --voice-only|--wait-closed)
      EXTRA_ARGS+=("$1")
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -f "$ROOT/.env.production.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.production.local"
  set +a
fi

API_URL="${API_URL:-https://serviceosapi-production.up.railway.app}"
OUT_DIR="${OUT_DIR:-/opt/cursor/artifacts/operator-voice-50-${CORPUS}-prod-$(date -u +%Y%m%d-%H%M)}"
CLERK_SECRET="${PROD_CLERK_SECRET_KEY:-${CLERK_SECRET_KEY:-}}"

if [[ -z "$JWT_FILE" ]]; then
  if [[ -z "$CLERK_SECRET" ]]; then
    echo "ERROR: use --jwt-file .tmp-prod-serviceos.jwt or set CLERK_SECRET_KEY=sk_live_…" >&2
    exit 1
  fi
  if [[ "$CLERK_SECRET" != sk_live_* ]]; then
    echo "ERROR: CLERK_SECRET_KEY must be sk_live_… (got ${CLERK_SECRET:0:8}…)." >&2
    echo "       Do not use cloud-agent sk_test_ keys against production." >&2
    exit 1
  fi
fi

if [[ "$MODE" == "--seed" ]]; then
  : "${PROD_DATABASE_URL:?PROD_DATABASE_URL required for --seed}"
  : "${QA_TENANT_ID:?QA_TENANT_ID required for --seed}"
  : "${QA_ACTOR_ID:?QA_ACTOR_ID required for --seed}"
  echo "Seeding operator voice fixtures on production tenant ${QA_TENANT_ID}…"
  (
    cd "$ROOT/packages/api"
    DATABASE_URL="$PROD_DATABASE_URL" \
    QA_TENANT_ID="$QA_TENANT_ID" \
    QA_ACTOR_ID="$QA_ACTOR_ID" \
    RAILWAY_ENVIRONMENT_NAME=production \
    ALLOW_OPERATOR_VOICE_FIXTURE_SEED_OUTSIDE_DEVELOPMENT=true \
    npx tsx scripts/seed-operator-voice-fixtures.ts
  )
fi

echo "Running operator voice top-50 (${CORPUS}) on ${API_URL}… ${EXTRA_ARGS[*]:-}"
export API_URL OUT_DIR
if [[ -n "$JWT_FILE" ]]; then
  exec node "$ROOT/scripts/production-retest.mjs" --probe "$CORPUS" --jwt-file "$JWT_FILE" "${EXTRA_ARGS[@]}"
fi
export CLERK_SECRET_KEY="$CLERK_SECRET"
exec node "$ROOT/scripts/production-retest.mjs" --probe "$CORPUS" "${EXTRA_ARGS[@]}"
