#!/usr/bin/env bash
# load-prod-env — source gitignored production Clerk keys for manual probes ONLY.
# Does not touch Railway. Never writes dev .env files.
#
# Usage:
#   source scripts/load-prod-env.sh
#   node scripts/production-retest.mjs
#
# Requires .env.production.local with sk_live_ / pk_live_ (see .env.production.example).

_prod_env_root="$(cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")/.." && pwd)"
_prod_env_file="$_prod_env_root/.env.production.local"

if [ ! -f "$_prod_env_file" ]; then
  echo "ERROR: $_prod_env_file missing." >&2
  echo "       Copy live keys from Railway production @serviceos/api → Variables." >&2
  echo "       Do NOT copy sk_test_ / pk_test_ from Development." >&2
  return 1 2>/dev/null || exit 1
fi

set -a
# shellcheck disable=SC1091
. "$_prod_env_file"
set +a

if [[ "${CLERK_SECRET_KEY:-}" == sk_test_* ]] || [[ "${CLERK_PUBLISHABLE_KEY:-}" == pk_test_* ]]; then
  echo "ERROR: .env.production.local contains dev/test Clerk keys — refused." >&2
  echo "       Production probes require sk_live_ / pk_live_ from therivetapp." >&2
  unset CLERK_SECRET_KEY CLERK_PUBLISHABLE_KEY VITE_CLERK_PUBLISHABLE_KEY
  return 1 2>/dev/null || exit 1
fi

if [[ "${CLERK_SECRET_KEY:-}" != sk_live_* ]]; then
  echo "ERROR: CLERK_SECRET_KEY must be sk_live_… in .env.production.local." >&2
  return 1 2>/dev/null || exit 1
fi

export API_URL="${API_URL:-${PROD_API_URL:-https://serviceosapi-production.up.railway.app}}"

echo "Production env loaded (local probe only — deployed Railway vars unchanged):"
echo "  API_URL=$API_URL"
echo "  CLERK_SECRET_KEY=${CLERK_SECRET_KEY:0:8}…"
