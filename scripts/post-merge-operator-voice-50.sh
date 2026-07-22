#!/usr/bin/env bash
# Post-merge operator voice Top-50 checklist (Development)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-https://serviceosapi-development.up.railway.app}"
OUT_DIR="${OUT_DIR:-/opt/cursor/artifacts/operator-voice-50-post-merge-$(date +%Y%m%d-%H%M%S)}"
QA_TENANT_ID="${QA_TENANT_ID:-b8e2dc0f-04c2-4ba0-9385-0ebcf3168052}"
QA_ACTOR_ID="${QA_ACTOR_ID:-25abab01-4303-4626-9672-af9a19bf6a64}"

echo "=== Operator Voice Top-50 post-merge checklist ==="
echo "API_URL=$API_URL"
echo "OUT_DIR=$OUT_DIR"
echo

echo "--- Step 0: Preflight ---"
curl -sf "$API_URL/health" | head -c 200 && echo
curl -sf "$API_URL/api/health/ai/completion" | head -c 300 && echo
echo

if [[ -z "${CLERK_SECRET_KEY:-}" ]]; then
  echo "ERROR: CLERK_SECRET_KEY is required for the probe."
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "--- Step 1: Seed fixtures (run 1) ---"
  (cd "$ROOT/packages/api" && \
    QA_TENANT_ID="$QA_TENANT_ID" QA_ACTOR_ID="$QA_ACTOR_ID" NODE_ENV=development \
    npx tsx scripts/seed-operator-voice-fixtures.ts)
  echo
  echo "--- Step 1b: Seed fixtures (run 2 — idempotency) ---"
  (cd "$ROOT/packages/api" && \
    QA_TENANT_ID="$QA_TENANT_ID" QA_ACTOR_ID="$QA_ACTOR_ID" NODE_ENV=development \
    npx tsx scripts/seed-operator-voice-fixtures.ts)
  echo
else
  echo "--- Step 1: Seed fixtures SKIPPED (set DATABASE_URL to run) ---"
  echo "  QA_TENANT_ID=$QA_TENANT_ID"
  echo "  QA_ACTOR_ID=$QA_ACTOR_ID"
  echo "  cd packages/api && DATABASE_URL=... NODE_ENV=development npx tsx scripts/seed-operator-voice-fixtures.ts"
  echo
fi

echo "--- Step 2: Full 50-workflow probe ---"
mkdir -p "$OUT_DIR"
API_URL="$API_URL" OUT_DIR="$OUT_DIR" node "$ROOT/scripts/probe-operator-voice-50-live.mjs" | tee "$OUT_DIR/probe.log"

echo
echo "--- Done ---"
echo "Results: $OUT_DIR/results.json"
echo "Report:  $OUT_DIR/REPORT.md"
