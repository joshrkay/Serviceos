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
#      responses for one canonical HVAC tradesperson command. Proves
#      the voice-action-router worker boots + classifier wiring +
#      proposal handler chain reach the InMemoryProposalRepository.
#      In-process — does NOT touch the deployed environment.
#
#   3. Deployed voice path (real call) — gated on SMOKE_API_TOKEN:
#      POSTs to /api/voice/sessions on the target host, submits the
#      same canonical command via /:id/input, asserts the deployed
#      response carries `proposalIds`, and DELETEs the session on the
#      way out. Catches breaks in the deployed LLM gateway / worker
#      registry / tenant config that Layer 2's mocks paper over.
#      Skipped (with a clear warning) when SMOKE_API_TOKEN or a remote
#      target is missing so dev runs of this script still work.
#
# Required env for Layer 3:
#   SMOKE_API_TOKEN  — Clerk JWT (template=serviceos) for a smoke
#                      tenant user with `ai:run`.
#   API_BASE_URL     — set by the outer `--env=…` arg or directly.
#
# Exit codes:
#   0 — every layer passed (or was intentionally skipped)
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
echo "==> [1/3] HTTP probes (liveness / readiness / telephony)"
if [ "${#SMOKE_ARGS[@]}" -eq 0 ] && [ -z "${API_BASE_URL:-}" ]; then
  echo "      no --env / --base / API_BASE_URL set — probing http://localhost:3000"
fi
if [ -n "${API_BASE_URL:-}" ] && [ "${#SMOKE_ARGS[@]}" -eq 0 ]; then
  SMOKE_ARGS+=("--base=$API_BASE_URL")
fi
( cd packages/api && npx tsx scripts/smoke-test.ts "${SMOKE_ARGS[@]}" )

# ── Layer 2: operator-voice scripted dry-run ───────────────────────────
echo ""
echo "==> [2/3] Operator-voice classifier dry-run (in-process)"
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

# ── Layer 3: deployed voice path (real call) ──────────────────────────
echo ""
echo "==> [3/3] Deployed voice path (real call)"

# Resolve the actual target base: prefer explicit env var, fall back
# to whatever --base= the inner harness already received.
TARGET_BASE="${API_BASE_URL:-}"
if [ -z "$TARGET_BASE" ]; then
  for arg in "${SMOKE_ARGS[@]}"; do
    case "$arg" in
      --base=*) TARGET_BASE="${arg#--base=}" ;;
    esac
  done
fi

if [ -z "$TARGET_BASE" ] || [ -z "${SMOKE_API_TOKEN:-}" ]; then
  echo "      ⚠️  skipping — needs SMOKE_API_TOKEN + a remote target (API_BASE_URL or --base=)."
  echo "      Layer 2's in-process dry-run still ran, but it does NOT exercise the deployed voice path."
else
  echo "      target: $TARGET_BASE"

  start_response="$(curl -sS -f -X POST "$TARGET_BASE/api/voice/sessions" \
    -H "Authorization: Bearer $SMOKE_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}')"
  session_id="$(printf '%s' "$start_response" | sed -nE 's/.*"sessionId":"([^"]+)".*/\1/p')"
  if [ -z "$session_id" ]; then
    echo "ERROR: deployed /api/voice/sessions returned no sessionId" >&2
    echo "Response: $start_response" >&2
    exit 1
  fi

  # Best-effort teardown so a smoke run doesn't litter the tenant with
  # half-finished sessions. Ignore failures — the idle reaper will
  # collect anything we leak.
  cleanup_smoke_session() {
    curl -sS -X DELETE "$TARGET_BASE/api/voice/sessions/$session_id" \
      -H "Authorization: Bearer $SMOKE_API_TOKEN" > /dev/null || true
  }
  trap cleanup_smoke_session EXIT

  input_response="$(curl -sS -f -X POST "$TARGET_BASE/api/voice/sessions/$session_id/input" \
    -H "Authorization: Bearer $SMOKE_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"text":"create an invoice for Mrs Lee for 450 dollars"}')"
  if ! printf '%s' "$input_response" | grep -qE '"proposalIds":\[[^]]*"[^"]+"'; then
    echo "ERROR: deployed voice path returned no proposalIds" >&2
    echo "Response: $input_response" >&2
    exit 1
  fi
  echo "      deployed voice path produced at least one proposal — OK"
fi

echo ""
echo "Smoke PASSED."
