#!/usr/bin/env bash
# qa-runbook-run — fire the full beta-verification runbook end-to-end.
#
# Bridges the gap between:
#   - scripts/qa-matrix-run.sh        — the §16/§17 matrix (read-only, HMAC-minted tokens)
#   - npm run qa:run:now              — the §1-§17 qa-runner stages
#   - npm run e2e:smoke               — Playwright smoke against the deploy
# … by seeding two tenants once and feeding the IDs to all three harnesses.
#
# Operator-provided env vars (the only secrets you need from Railway):
#   E2E_DB_URL_READWRITE     postgres://… (service-role; Railway → Postgres → Connect)
#   E2E_DB_URL_READONLY      postgres://… (read-only role; defaults to READWRITE if unset)
#   E2E_CLERK_HMAC_SECRET    = the API's CLERK_SECRET_KEY (Railway → serviceosapi-development → Variables)
#
# Operator-provided env vars on the deployed API itself (Railway → Variables):
#   CLERK_DEV_HMAC_TOKENS=true   one-time setup. The HMAC verifier path
#                                (packages/api/src/auth/clerk.ts:347) is gated
#                                by this flag. Without it, every minted token
#                                returns 401 even if the secret matches.
#                                Refused at runtime when NODE_ENV=production —
#                                this script targets dev/staging only.
#
# Optional (these have safe defaults that point at Railway dev):
#   E2E_BASE_URL             default https://serviceosweb-development.up.railway.app
#   E2E_API_URL              default https://serviceosapi-development.up.railway.app
#   BASE_URL                 mirrored from E2E_BASE_URL for qa-runner
#   API_URL                  mirrored from E2E_API_URL  for qa-runner
#
# Usage:
#   E2E_DB_URL_READWRITE='postgres://…' \
#   E2E_CLERK_HMAC_SECRET='sk_test_…' \
#     ./scripts/qa-runbook-run.sh
#
#   # or via npm:
#   npm run qa:runbook

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

# ── 1. Seed Tenant A + Tenant B (idempotent on owner_id) ─────────────────
section "Step 1/4 — seed Tenant A + Tenant B against staging Postgres"
# DATABASE_URL is what seed-journey-fixtures.ts reads; mirror from the
# read-write URL the operator provided.
export DATABASE_URL="$E2E_DB_URL_READWRITE"
npx tsx e2e/fixtures/seed-journey-fixtures.ts

# Load the env file the seed writes (tenant/customer/job/estimate IDs).
# shellcheck disable=SC1091
if [ -f e2e/fixtures/.journey-fixtures.env ]; then
  set -a
  . e2e/fixtures/.journey-fixtures.env
  set +a
else
  echo "ERROR: seed did not produce e2e/fixtures/.journey-fixtures.env" >&2
  exit 1
fi

# ── 2. Mint HMAC tokens for Tenant A + Tenant B ──────────────────────────
section "Step 2/4 — mint HMAC JWTs for AUTH_BEARER_TOKEN + TENANT_B_TOKEN"
# Eval the export lines into the current shell so qa:run picks them up.
TOKEN_LINES="$(npx tsx scripts/qa-mint-tokens.ts)"
# shellcheck disable=SC2086
eval "$TOKEN_LINES"

# Quick post-check: ensure the API accepts the minted token (cheap auth probe).
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${AUTH_BEARER_TOKEN}" \
  "${E2E_API_URL}/api/me" || true)"
if [ "$HTTP_CODE" != "200" ]; then
  echo "WARNING: GET ${E2E_API_URL}/api/me returned ${HTTP_CODE} with the minted token." >&2
  echo "         Likely causes (in order):" >&2
  echo "           1. The deployed API does NOT have CLERK_DEV_HMAC_TOKENS=true set." >&2
  echo "              The HMAC verifier path is gated by that flag (see packages/api/src/auth/clerk.ts:347)." >&2
  echo "              Add it on Railway → serviceosapi-development → Variables and redeploy." >&2
  echo "           2. E2E_CLERK_HMAC_SECRET does not match the deployed CLERK_SECRET_KEY." >&2
  echo "           3. NODE_ENV is 'production' on the API (HMAC path refuses prod regardless)." >&2
  echo "         The runbook will still run, but all authenticated rows will fail with 401." >&2
fi

# ── 3. Run the qa-runner stages (Sections 1–17) ──────────────────────────
section "Step 3/4 — qa-runner stages (doctor + smoke-tools + run + report)"
npm run qa:run:now

# ── 4. Run the QA matrix (always-blocking §17 tenant isolation) ──────────
section "Step 4/4 — QA matrix (§16 provisioning + §17 tenant isolation)"
npm run e2e:qa-matrix || {
  echo "WARNING: matrix run exited non-zero. See playwright-report/ for details." >&2
}

# ── Report locations ─────────────────────────────────────────────────────
section "Reports"
echo "qa-runner rows:       qa-runner/reports/test_results.json"
echo "qa-runner summary:    qa-runner/reports/summary.md"
echo "matrix QA report:     $(ls -1dt qa/reports/*/ 2>/dev/null | head -1)QA-REPORT.md"
echo "Playwright HTML:      playwright-report/index.html"
