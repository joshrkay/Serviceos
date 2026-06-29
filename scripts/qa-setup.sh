#!/usr/bin/env bash
# qa-setup — one-shot bootstrap from a filled .env.qa to matrix/runbook readiness.
#
# Orchestrates:
#   1. Load .env.qa (optional but recommended)
#   2. Seed journey fixtures (qa-runner tenant IDs)
#   3. Seed matrix fixtures (E2E_TENANT_* for Playwright matrix)
#   4. Mint HMAC JWTs and probe GET /api/me
#   5. Full qa:doctor gate
#
# Usage:
#   cp .env.qa.example .env.qa   # fill Railway secrets
#   source .env.qa
#   npm run qa:setup
#
# See docs/runbooks/qa-full-matrix-unblock.md

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
QA_REPO_ROOT="$REPO_ROOT"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/qa-env.sh"

section() {
  echo ""
  echo "=========================================================="
  echo "  $1"
  echo "=========================================================="
}

load_qa_env
apply_qa_defaults

require_qa_env E2E_DB_URL_READWRITE
require_qa_env E2E_DB_URL_READONLY
require_qa_env E2E_CLERK_HMAC_SECRET
require_qa_env E2E_BASE_URL
require_qa_env E2E_API_URL

# ── 1. Bootstrap doctor (URLs + DB + HMAC before seed) ─────────────────────
section "Step 1/6 — bootstrap doctor (URLs + DB + HMAC secret)"
npm run qa:doctor:bootstrap

# ── 2. Seed journey fixtures (qa-runner IDs) ───────────────────────────────
section "Step 2/6 — seed journey fixtures (qa-runner)"
export DATABASE_URL="$E2E_DB_URL_READWRITE"
npx tsx e2e/fixtures/seed-journey-fixtures.ts

if [ -f e2e/fixtures/.journey-fixtures.env ]; then
  set -a
  # shellcheck disable=SC1091
  . e2e/fixtures/.journey-fixtures.env
  set +a
else
  echo "ERROR: seed did not produce e2e/fixtures/.journey-fixtures.env" >&2
  exit 1
fi

# ── 3. Seed matrix fixtures (E2E_TENANT_* for Playwright) ────────────────
section "Step 3/6 — seed matrix fixtures (E2E_TENANT_*)"
MATRIX_EXPORTS="$(npx tsx e2e/qa-matrix/fixtures/seed.ts | grep '^export E2E_')"
# shellcheck disable=SC2086
eval "$MATRIX_EXPORTS"
write_qa_local_env "$MATRIX_EXPORTS"

# ── 4. Mint HMAC tokens (journey tenant IDs for qa-runner) ───────────────
section "Step 4/6 — mint HMAC JWTs"
# Matrix seed overwrote E2E_TENANT_* above; qa-runner expects journey IDs.
# Mint in a subshell that re-sources the journey env file.
TOKEN_LINES="$(
  set -a
  # shellcheck disable=SC1091
  . e2e/fixtures/.journey-fixtures.env
  set +a
  npx tsx scripts/qa-mint-tokens.ts
)"
# shellcheck disable=SC2086
eval "$TOKEN_LINES"

# ── 5. HMAC auth probe (fail fast) ───────────────────────────────────────
section "Step 5/6 — HMAC auth probe (GET /api/me)"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${AUTH_BEARER_TOKEN}" \
  "${E2E_API_URL}/api/me" || true)"
if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: GET ${E2E_API_URL}/api/me returned ${HTTP_CODE} with the minted token." >&2
  echo "       Likely causes (in order):" >&2
  echo "         1. The deployed API does NOT have CLERK_DEV_HMAC_TOKENS=true set." >&2
  echo "            Railway → serviceosapi-development → Variables → redeploy." >&2
  echo "         2. E2E_CLERK_HMAC_SECRET does not match the deployed CLERK_SECRET_KEY." >&2
  echo "         3. NODE_ENV is 'production' on the API (HMAC path refused)." >&2
  echo "       See docs/runbooks/qa-full-matrix-unblock.md#troubleshooting" >&2
  exit 1
fi
echo "HMAC probe OK (200 from /api/me)"

# ── 6. Full doctor ─────────────────────────────────────────────────────
section "Step 6/6 — full doctor (all 11 vars + HMAC probe)"
npm run qa:doctor

section "Ready"
echo "Bootstrap complete. Next steps:"
echo "  npm run qa:matrix:run   # matrix only (doctor → seed → matrix → gate)"
echo "  npm run qa:runbook      # full beta (journey seed + qa-runner §1–17 + matrix)"
echo ""
echo "Journey tenant IDs are in e2e/fixtures/.journey-fixtures.env"
echo "Matrix tenant IDs are exported as E2E_TENANT_* in your shell"
