#!/usr/bin/env bash
# Apply AI provider Profile A (OpenAI) or B (OpenRouter) to BOTH Railway
# environments: Development and production.
#
# Why both: 2026-07-20 incident left Dev on OpenAI+Claude mismatch and Prod
# with empty providers. Fixing only one env leaves the money loop dead on the
# other. See docs/runbooks/live-ai-restore.md.
#
# Prerequisites:
#   - railway CLI authenticated (RAILWAY_TOKEN or `railway login`)
#   - project linked (`railway link`) OR RAILWAY_PROJECT_ID set
#   - AI_PROVIDER_API_KEY exported (never commit the key)
#
# Usage:
#   export AI_PROVIDER_API_KEY='sk-...'          # OpenAI for A, sk-or-… for B
#   ./scripts/apply-railway-ai-profile.sh a     # Profile A → Dev + Prod
#   ./scripts/apply-railway-ai-profile.sh b     # Profile B → Dev + Prod
#
# Optional:
#   RAILWAY_SERVICE='@serviceos/api'            # default
#   RAILWAY_ENVS='Development production'       # default both
#   ALSO_WORKER=1                               # also set on @serviceos/worker if present
#   SKIP_DEPLOYS=1                              # pass --skip-deploys
#   DRY_RUN=1                                   # print commands only
set -euo pipefail

PROFILE="${1:-}"
if [[ "$PROFILE" != "a" && "$PROFILE" != "b" && "$PROFILE" != "A" && "$PROFILE" != "B" ]]; then
  echo "Usage: $0 a|b" >&2
  echo "  a = OpenAI Profile A (gpt-4o-mini / gpt-4o)" >&2
  echo "  b = OpenRouter Profile B (Llama / Qwen VL)" >&2
  exit 2
fi
PROFILE="$(echo "$PROFILE" | tr '[:upper:]' '[:lower:]')"

if [[ -z "${AI_PROVIDER_API_KEY:-}" ]]; then
  echo "FAIL: export AI_PROVIDER_API_KEY before running (never commit the key)." >&2
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
if [[ -z "$RAILWAY_BIN" ]]; then
  RAILWAY_BIN="$(ls -1 "${HOME}"/.npm/_npx/*/node_modules/@railway/cli/bin/railway.js 2>/dev/null | head -1 || true)"
fi
if [[ -z "${RAILWAY_BIN}" && "${DRY_RUN:-}" != "1" ]]; then
  echo "FAIL: railway CLI not found. Install: npm i -g @railway/cli" >&2
  echo "  or: npx @railway/cli whoami" >&2
  exit 1
fi
RAILWAY_BIN="${RAILWAY_BIN:-railway}"

if [[ "$PROFILE" == "a" ]]; then
  PROFILE_LABEL="A (OpenAI)"
  BASE_URL="https://api.openai.com/v1"
  DEFAULT_MODEL="gpt-4o-mini"
  LIGHT="gpt-4o-mini"
  STANDARD="gpt-4o-mini"
  COMPLEX="gpt-4o"
else
  PROFILE_LABEL="B (OpenRouter)"
  BASE_URL="https://openrouter.ai/api/v1"
  DEFAULT_MODEL=""
  LIGHT="meta-llama/llama-3.1-8b-instruct"
  STANDARD="meta-llama/llama-3.3-70b-instruct"
  COMPLEX="qwen/qwen2.5-vl-72b-instruct"
fi

run() {
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    # Redact key in dry-run output
    local shown=()
    local a
    for a in "$@"; do
      if [[ "$a" == AI_PROVIDER_API_KEY=* ]]; then
        shown+=("AI_PROVIDER_API_KEY=(redacted)")
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
  echo "═══ ${svc} / ${env_name} — Profile ${PROFILE_LABEL} ═══"

  local set_args=(
    "AI_PROVIDER_BASE_URL=${BASE_URL}"
    "AI_PROVIDER_API_KEY=${AI_PROVIDER_API_KEY}"
    "AI_LIGHTWEIGHT_MODEL=${LIGHT}"
    "AI_STANDARD_MODEL=${STANDARD}"
    "AI_COMPLEX_MODEL=${COMPLEX}"
  )
  if [[ -n "$DEFAULT_MODEL" ]]; then
    set_args+=("AI_DEFAULT_MODEL=${DEFAULT_MODEL}")
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

  echo "OK: set AI_* on ${svc} / ${env_name}"
}

SERVICES=("$SERVICE")
if [[ "${ALSO_WORKER:-}" == "1" ]]; then
  SERVICES+=("@serviceos/worker")
fi

echo "Applying AI Profile ${PROFILE_LABEL} to environments: ${ENVS[*]}"
echo "Services: ${SERVICES[*]}"
echo "Base URL: ${BASE_URL}"
echo "Models: light=${LIGHT} standard=${STANDARD} complex=${COMPLEX}"

for env_name in "${ENVS[@]}"; do
  for svc in "${SERVICES[@]}"; do
    apply_one "$env_name" "$svc"
  done
done

echo ""
echo "Done. Redeploy if SKIP_DEPLOYS=1 was set, then verify both hosts:"
echo "  ./scripts/verify-live-ai-envs.sh"
echo "See docs/runbooks/live-ai-restore.md"
