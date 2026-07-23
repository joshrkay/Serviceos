#!/usr/bin/env bash
# load-dev-env — source Railway Development environment into your shell.
#
# Usage:
#   source scripts/load-dev-env.sh
#
# Creates/populates (from cloud agent secrets on first run):
#   .env.qa              — Railway dev URLs, DB, Clerk HMAC
#   .env.qa.local        — tenant UUIDs pulled from dev Postgres
#   .env                 — root local dev
#   packages/api/.env    — API package
#   packages/web/.env.local — web package (Vite)
#
# After sourcing, run probes / QA:
#   npm run qa:doctor
#   CASES_PATH=fixtures/voice/operator-voice-top-50-v4-cases.json \
#     node scripts/probe-operator-voice-50-live.mjs

_dev_env_root="$(cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")/.." && pwd)"

if [ ! -f "$_dev_env_root/.env.qa" ]; then
  echo "ERROR: $_dev_env_root/.env.qa missing." >&2
  echo "       Copy .env.qa.example and fill Railway Development secrets." >&2
  return 1 2>/dev/null || exit 1
fi

set -a
# shellcheck disable=SC1091
. "$_dev_env_root/.env.qa"
if [ -f "$_dev_env_root/.env.qa.local" ]; then
  # shellcheck disable=SC1091
  . "$_dev_env_root/.env.qa.local"
fi
if [ -f "$_dev_env_root/.env" ]; then
  # shellcheck disable=SC1091
  . "$_dev_env_root/.env"
fi
set +a

if [[ "${CLERK_SECRET_KEY:-}" == sk_live_* ]]; then
  echo "WARNING: CLERK_SECRET_KEY is sk_live_ but load-dev-env is for Development only." >&2
  echo "         Use: source scripts/load-prod-env.sh" >&2
fi

export BASE_URL="${BASE_URL:-$E2E_BASE_URL}"
export API_URL="${API_URL:-$E2E_API_URL}"
export DATABASE_URL="${DATABASE_URL:-$E2E_DB_URL_READWRITE}"

echo "Development env loaded:"
echo "  API_URL=$API_URL"
echo "  E2E_TENANT_A_ID=${E2E_TENANT_A_ID:-<unset>}"
echo "  QA_TENANT_ID=${QA_TENANT_ID:-<unset>}"
