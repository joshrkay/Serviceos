#!/usr/bin/env bash
# Apply OpenRouter dual-provider failover vars WITHOUT replacing Profile A primary.
#
# Unlike apply-railway-ai-profile.sh b (wholesale OpenRouter primary swap), this
# only sets AI_FALLBACK_PROVIDER_* (+ optional classify deadline) so
# createLLMGateway wires fallbackProviders while OpenAI stays primary.
#
# Prerequisites:
#   - railway CLI authenticated (RAILWAY_TOKEN or `railway login`)
#   - project linked (`railway link`) OR RAILWAY_PROJECT_ID set
#   - AI_FALLBACK_PROVIDER_API_KEY exported (never commit the key)
#
# Usage:
#   export AI_FALLBACK_PROVIDER_API_KEY='sk-or-...'
#   ./scripts/apply-railway-ai-fallback.sh
#
# Optional:
#   AI_FALLBACK_PROVIDER_BASE_URL=https://openrouter.ai/api/v1   # default
#   AI_FALLBACK_LIGHTWEIGHT_MODEL=meta-llama/llama-3.1-8b-instruct
#   SET_CLASSIFY_DEADLINE=12000   # also set AI_CLASSIFY_INTENT_DEADLINE_MS
#   RAILWAY_SERVICE='@serviceos/api'
#   RAILWAY_ENVS='Development production'
#   ALSO_WORKER=1
#   SKIP_DEPLOYS=1
#   DRY_RUN=1
set -euo pipefail

if [[ -z "${AI_FALLBACK_PROVIDER_API_KEY:-}" ]]; then
  echo "FAIL: export AI_FALLBACK_PROVIDER_API_KEY before running (never commit the key)." >&2
  exit 1
fi

FALLBACK_BASE_URL="${AI_FALLBACK_PROVIDER_BASE_URL:-https://openrouter.ai/api/v1}"
FALLBACK_LIGHT="${AI_FALLBACK_LIGHTWEIGHT_MODEL:-meta-llama/llama-3.1-8b-instruct}"
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
if [[ -z "$RAILWAY_BIN" ]]; then
  RAILWAY_BIN="$(ls -1 "${HOME}"/.npm/_npx/*/node_modules/@railway/cli/bin/railway.js 2>/dev/null | head -1 || true)"
fi
if [[ -z "${RAILWAY_BIN}" && "${DRY_RUN:-}" != "1" ]]; then
  echo "FAIL: railway CLI not found. Install: npm i -g @railway/cli" >&2
  exit 1
fi
RAILWAY_BIN="${RAILWAY_BIN:-railway}"

run() {
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    local shown=()
    local a
    for a in "$@"; do
      if [[ "$a" == AI_FALLBACK_PROVIDER_API_KEY=* ]]; then
        shown+=("AI_FALLBACK_PROVIDER_API_KEY=(redacted)")
      else
        shown+=("$a")
      fi
    done
    echo "DRY_RUN: ${shown[*]}"
  else
    "$@"
  fi
}

apply_one() {
  local env_name="$1"
  local svc="$2"
  echo ""
  echo "═══ ${svc} / ${env_name} — OpenRouter failover (primary unchanged) ═══"

  local set_args=(
    "AI_FALLBACK_PROVIDER_BASE_URL=${FALLBACK_BASE_URL}"
    "AI_FALLBACK_PROVIDER_API_KEY=${AI_FALLBACK_PROVIDER_API_KEY}"
    "AI_FALLBACK_LIGHTWEIGHT_MODEL=${FALLBACK_LIGHT}"
  )
  if [[ -n "${SET_CLASSIFY_DEADLINE:-}" ]]; then
    set_args+=("AI_CLASSIFY_INTENT_DEADLINE_MS=${SET_CLASSIFY_DEADLINE}")
  fi

  if [[ "$RAILWAY_BIN" == *.js ]]; then
    run node "$RAILWAY_BIN" variable set \
      --service "$svc" \
      --environment "$env_name" \
      "${SKIP_ARGS[@]}" \
      "${set_args[@]}"
  else
    run "$RAILWAY_BIN" variable set \
      --service "$svc" \
      --environment "$env_name" \
      "${SKIP_ARGS[@]}" \
      "${set_args[@]}"
  fi

  echo "OK: set AI_FALLBACK_* on ${svc} / ${env_name}"
}

SERVICES=("$SERVICE")
if [[ "${ALSO_WORKER:-}" == "1" ]]; then
  SERVICES+=("@serviceos/worker")
fi

echo "Applying OpenRouter failover vars to environments: ${ENVS[*]}"
echo "Services: ${SERVICES[*]}"
echo "Fallback base URL: ${FALLBACK_BASE_URL}"
echo "Fallback lightweight model: ${FALLBACK_LIGHT}"
echo "NOTE: Does not change AI_PROVIDER_* primary (use Profile A for that)."

for env_name in "${ENVS[@]}"; do
  for svc in "${SERVICES[@]}"; do
    apply_one "$env_name" "$svc"
  done
done

echo ""
echo "Done. Redeploy if SKIP_DEPLOYS=1 was set, then verify:"
echo "  ./scripts/verify-live-ai-envs.sh"
echo "  cd packages/api && npm run check:ai-provider-config"
echo "See docs/runbooks/live-ai-restore.md (Profile A + OpenRouter fallback)"
