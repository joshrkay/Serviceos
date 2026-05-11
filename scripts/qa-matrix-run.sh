#!/usr/bin/env bash
# qa-matrix-run — fire the 4-agent QA matrix against Railway dev end-to-end.
#
# Order:
#   1. doctor       — pre-flight env + reachability checks
#   2. smoke-tools  — verify Playwright / Stripe CLI / tsx are usable
#   3. seed         — idempotent fixture seeder (writes tenants A and B)
#   4. matrix       — npm run e2e:qa-matrix
#   5. report       — print the path to the freshly built QA-REPORT.md
#
# Fails fast on any step. Run from the repo root.
#
# Usage:
#   ./scripts/qa-matrix-run.sh
#   # or via npm:
#   npm run qa:matrix:run

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

section() {
  echo ""
  echo "=========================================================="
  echo "  $1"
  echo "=========================================================="
}

section "Step 1/5 — qa-matrix doctor (env + reachability)"
npx tsx --no-warnings scripts/qa-matrix-doctor.ts

section "Step 2/5 — smoke-tools (Playwright / Stripe / tsx)"
npx tsx --no-warnings scripts/qa-smoke-tools.ts

section "Step 3/5 — seed Tenant A + Tenant B"
# The seeder requires E2E_DB_URL_READWRITE; doctor already verified it.
# Seeder is idempotent on owner_id, so re-runs are safe.
npx tsx e2e/qa-matrix/fixtures/seed.ts

section "Step 4/5 — run the QA matrix (18 rows)"
# e2e:qa-matrix sets QA_MATRIX=1 and runs the qa-matrix Playwright project.
npm run e2e:qa-matrix

section "Step 5/5 — locate the QA report"
# Newest dated report dir is the one we just wrote.
if [ -d qa/reports ]; then
  ls -lat qa/reports/ | head -10
  LATEST_DIR="$(ls -1dt qa/reports/*/ 2>/dev/null | head -1 || true)"
  if [ -n "${LATEST_DIR:-}" ]; then
    REPORT="${LATEST_DIR}QA-REPORT.md"
    if [ -f "$REPORT" ]; then
      echo ""
      echo "QA report: ${REPORT}"
      echo "Open with: open ${REPORT}   (mac)"
      echo "        or: code ${REPORT}  (vscode)"
    else
      echo ""
      echo "WARNING: latest dir ${LATEST_DIR} has no QA-REPORT.md yet."
      echo "Check ${LATEST_DIR} for partial artifacts."
      exit 1
    fi
  else
    echo "WARNING: no dated report dir found under qa/reports/"
    exit 1
  fi
else
  echo "WARNING: qa/reports/ does not exist; teardown may have failed."
  exit 1
fi
