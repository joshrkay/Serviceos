#!/usr/bin/env bash
# Launch smoke test — ties together the HTTP liveness probes and the
# operator-voice classifier so a single command verifies a deploy.
#
# Usage:
#   API_BASE_URL=https://example.com  ./scripts/smoke.sh
#   ./scripts/smoke.sh --env=staging
#   ./scripts/smoke.sh --env=prod
#
# Layers (each fails fast and bubbles up an exit code):
#
#   1. HTTP probes:  /health, /ready, /api/telephony/health
#      Delegates to packages/api/scripts/smoke-test.ts so a deploy-
#      health regression is caught the same way the existing per-
#      component smoke catches it.
#
#   2. Operator-voice classifier dry-run:
#      Runs packages/api/scripts/test-voice.ts with scripted LLM
#      responses for one canonical HVAC tradesperson command
#      ("create an invoice for Mrs Lee for 450 dollars"). Proves the
#      voice-action-router worker boots + classifier wiring + proposal
#      handler chain reach the InMemoryProposalRepository. No external
#      AI key required; the scripted gateway is deterministic.
#
# Exit codes:
#   0 — every layer passed
#   1 — a layer failed (the failing one prints its own diagnostics)
#   2 — bad usage
#
# Wiring into deploy:
#   Add as a post-deploy gate before promoting dev → prod. See
#   docs/runbooks/launch-quality-bar.md for the runbook entry.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── parse args (passthrough to the inner smoke harness) ────────────────
SMOKE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --env=*|--base=*) SMOKE_ARGS+=("$arg") ;;
    --help|-h)
      sed -n '1,/^set -euo pipefail$/p' "$0" | sed -n '/^#/p' | sed 's/^# //;s/^#//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$arg'. See --help." >&2
      exit 2
      ;;
  esac
done

# ── Layer 1: HTTP probes ───────────────────────────────────────────────
echo "==> [1/2] HTTP probes (liveness / readiness / telephony)"
if [ "${#SMOKE_ARGS[@]}" -eq 0 ] && [ -z "${API_BASE_URL:-}" ]; then
  echo "      no --env / --base / API_BASE_URL set — probing http://localhost:3000"
fi
if [ -n "${API_BASE_URL:-}" ] && [ "${#SMOKE_ARGS[@]}" -eq 0 ]; then
  SMOKE_ARGS+=("--base=$API_BASE_URL")
fi
( cd packages/api && npx tsx scripts/smoke-test.ts "${SMOKE_ARGS[@]}" )

# ── Layer 2: operator-voice scripted dry-run ───────────────────────────
echo ""
echo "==> [2/2] Operator-voice classifier dry-run (in-process)"
# Two scripted LLM responses are popped from MOCK_RESPONSES in order:
#   (1) classifier output for "create an invoice for Mrs Lee for 450 dollars"
#   (2) invoice-task structured output for the proposal payload
# The script exits 0 when a draft_invoice proposal is created, 1 on
# 'unknown' classification or a chain failure. Both are wired below.
export MOCK_RESPONSES='[
  {"intentType":"create_invoice","confidence":0.92,"extractedEntities":{"customerName":"Mrs Lee","amount":45000}},
  {"customerId":"smoke-cust","jobId":"smoke-job","lineItems":[{"description":"Repair","quantity":1,"unitPrice":45000}],"confidence_score":0.92}
]'
( cd packages/api && npx tsx scripts/test-voice.ts \
    "create an invoice for Mrs Lee for 450 dollars" )

echo ""
echo "Smoke PASSED."
