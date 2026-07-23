#!/usr/bin/env bash
# Run operator voice top-50 against production API (RS256 Clerk serviceos JWT).
#
# Prerequisites (one-time on production):
#   1. CLERK_SECRET_KEY=sk_live_… (therivetapp production Clerk instance)
#   2. CLERK_USER_ID=user_… with public_metadata { tenant_id, role } + users row
#   3. Operator voice fixtures seeded on that tenant (see seed block below)
#
# Usage:
#   CLERK_SECRET_KEY=sk_live_… \
#   CLERK_USER_ID=user_… \
#   ./scripts/run-production-operator-voice-50.sh v3
#
# Optional fixture seed (requires production Postgres):
#   PROD_DATABASE_URL=postgres://… \
#   QA_TENANT_ID=… QA_ACTOR_ID=… \
#   ALLOW_OPERATOR_VOICE_FIXTURE_SEED_OUTSIDE_DEVELOPMENT=true \
#   ./scripts/run-production-operator-voice-50.sh v3 --seed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORPUS="${1:-v3}"
SEED="${2:-}"

API_URL="${API_URL:-https://serviceosapi-production.up.railway.app}"
OUT_DIR="${OUT_DIR:-/opt/cursor/artifacts/operator-voice-50-${CORPUS}-prod-$(date -u +%Y%m%d-%H%M)}"
CLERK_SECRET="${CLERK_SECRET_KEY:-${E2E_CLERK_SECRET_KEY:-}}"

if [[ -z "$CLERK_SECRET" ]]; then
  echo "ERROR: CLERK_SECRET_KEY (sk_live_…) is required for production probes." >&2
  echo "Production API verifies therivetapp live Clerk JWKS; sk_test_ tokens return 401." >&2
  exit 1
fi

if [[ "$CLERK_SECRET" != sk_live_* ]]; then
  echo "ERROR: CLERK_SECRET_KEY must be sk_live_… (got ${CLERK_SECRET:0:8}…)." >&2
  echo "Inject the production Clerk secret into this agent environment, then re-run." >&2
  exit 1
fi

if [[ "$SEED" == "--seed" ]]; then
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

echo "Running operator voice top-50 (${CORPUS}) on ${API_URL}…"
export API_URL OUT_DIR CLERK_SECRET_KEY="$CLERK_SECRET"
exec node "$ROOT/scripts/production-retest.mjs" --probe "$CORPUS"
