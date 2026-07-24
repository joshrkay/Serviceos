#!/usr/bin/env bash
# Apply OpenRouter as a FALLBACK provider alongside Profile A (OpenAI primary).
#
# This is NOT Profile B (which replaces the primary). Dual-provider failover
# requires createLLMGateway() wiring from AI_FALLBACK_PROVIDER_* (FM-03).
# See docs/runbooks/live-ai-restore.md ("Profile A + OpenRouter fallback").
#
# Prerequisites:
#   - railway CLI authenticated
#   - AI_FALLBACK_PROVIDER_API_KEY exported (sk-or-…; never commit)
#
# Usage:
#   export AI_FALLBACK_PROVIDER_API_KEY='sk-or-...'
#   ./scripts/apply-railway-ai-fallback.sh
#
# Optional:
#   RAILWAY_SERVICE='@serviceos/api'
#   RAILWAY_ENVS='Development production'
#   SKIP_DEPLOYS=1
#   DRY_RUN=1
set -euo pipefail

if [[ -z "${AI_FALLBACK_PROVIDER_API_KEY:-}" ]]; then
  echo "FAIL: export AI_FALLBACK_PROVIDER_API_KEY before running (never commit the key)." >&2
  exit 1
fi

SERVICE="${RAILWAY_SERVICE:-@serviceos/api}"
# shellcheck disable=SC2206
ENVS=(${RAILWAY_ENVS:-Development production})
SKIP_ARGS=()
if [[ "${SKIP_DEPLOYS:-}" == "1" ]]; then
  SKIP_ARGS+=(--skip-deploys)
fi

RAILWAY_BIN="${RAILWAY_BIN:-}"
if [[ -z "$RAILWAY_BIN" ]] && command -v railway >/dev/null 2>&1; then
  RAILWAY_BIN="$(command -v railway)"
fi
if [[ -z "$RAILWAY_BIN" && "${DRY_RUN:-}" != "1" ]]; then
  echo "FAIL: railway CLI not found. Install: npm i -g @railway/cli" >&2
  exit 1
fi
RAILWAY_BIN="${RAILWAY_BIN:-railway}"

BASE_URL="${AI_FALLBACK_PROVIDER_BASE_URL:-https://openrouter.ai/api/v1}"
LIGHT="${AI_FALLBACK_LIGHTWEIGHT_MODEL:-meta-llama/llama-3.1-8b-instruct}"
STANDARD="${AI_FALLBACK_STANDARD_MODEL:-meta-llama/llama-3.3-70b-instruct}"
COMPLEX="${AI_FALLBACK_COMPLEX_MODEL:-qwen/qwen2.5-vl-72b-instruct}"
# Keep classify deadline pinned whenever we touch AI vars (empty → 4s regression).
CLASSIFY_DEADLINE="${AI_CLASSIFY_INTENT_DEADLINE_MS:-12000}"

run() {
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "DRY_RUN: $*"
  else
    "$@"
  fi
}

echo "Applying AI fallback (OpenRouter) on ${SERVICE} for: ${ENVS[*]}"
echo "  BASE_URL=${BASE_URL}"
echo "  LIGHT=${LIGHT}"
echo "  AI_CLASSIFY_INTENT_DEADLINE_MS=${CLASSIFY_DEADLINE}"

for env_name in "${ENVS[@]}"; do
  echo "--- environment: ${env_name}"
  run "$RAILWAY_BIN" variables set \
    --service "$SERVICE" \
    --environment "$env_name" \
    "${SKIP_ARGS[@]}" \
    "AI_FALLBACK_PROVIDER_API_KEY=${AI_FALLBACK_PROVIDER_API_KEY}" \
    "AI_FALLBACK_PROVIDER_BASE_URL=${BASE_URL}" \
    "AI_FALLBACK_LIGHTWEIGHT_MODEL=${LIGHT}" \
    "AI_FALLBACK_STANDARD_MODEL=${STANDARD}" \
    "AI_FALLBACK_COMPLEX_MODEL=${COMPLEX}" \
    "AI_CLASSIFY_INTENT_DEADLINE_MS=${CLASSIFY_DEADLINE}"
done

echo "Done. Primary Profile A vars are unchanged."
echo "Verify: ./scripts/verify-live-ai-envs.sh && warm classify on production."
