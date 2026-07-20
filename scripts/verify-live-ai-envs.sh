#!/usr/bin/env bash
# Verify live AI config on BOTH Railway API hosts (Development + production).
#
# Usage:
#   ./scripts/verify-live-ai-envs.sh
#   DEV_API_URL=https://… PROD_API_URL=https://… ./scripts/verify-live-ai-envs.sh
#   METRICS_TOKEN=… ./scripts/verify-live-ai-envs.sh   # for /completion when gated
#
# Exit 0 only when both hosts have a non-empty providers list AND (when the
# completion route exists) a successful completion probe — or when COMPLETION
# is skipped via SKIP_COMPLETION=1.
set -euo pipefail

DEV_API_URL="${DEV_API_URL:-https://serviceosapi-development.up.railway.app}"
PROD_API_URL="${PROD_API_URL:-https://serviceosapi-production.up.railway.app}"

auth_hdr=()
if [[ -n "${METRICS_TOKEN:-}" ]]; then
  auth_hdr=(-H "Authorization: Bearer ${METRICS_TOKEN}")
fi

FAIL=0

check_host() {
  local label="$1"
  local base="$2"
  echo ""
  echo "═══ ${label} (${base}) ═══"

  local health ai
  health="$(curl -sS --max-time 20 "${base}/health" || echo '{}')"
  ai="$(curl -sS --max-time 20 "${base}/api/health/ai" || echo '{}')"

  local env_name providers_len
  env_name="$(echo "$health" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("environment","?"))' 2>/dev/null || echo '?')"
  providers_len="$(echo "$ai" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("providers") or []))' 2>/dev/null || echo 0)"
  local provider_names
  provider_names="$(echo "$ai" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(",".join(p.get("name","?") for p in (d.get("providers") or [])))' 2>/dev/null || echo '')"

  echo "  /health environment = ${env_name}"
  echo "  /api/health/ai providers (${providers_len}) = ${provider_names:-"(empty)"}"

  if [[ "$providers_len" == "0" ]]; then
    echo "  FAIL: no AI providers (missing AI_PROVIDER_API_KEY → hermetic mock)"
    FAIL=1
  fi

  if [[ "${SKIP_COMPLETION:-}" == "1" ]]; then
    echo "  SKIP: completion probe (SKIP_COMPLETION=1)"
    return
  fi

  local code body
  code="$(curl -sS --max-time 60 -o /tmp/ai-comp-"${label}".json -w '%{http_code}' \
    "${auth_hdr[@]}" "${base}/api/health/ai/completion" || echo '000')"
  body="$(head -c 800 /tmp/ai-comp-"${label}".json 2>/dev/null || true)"
  echo "  /api/health/ai/completion HTTP ${code}"
  echo "  body: ${body}"

  if [[ "$code" == "401" || "$code" == "403" ]]; then
    echo "  WARN: completion gated (set METRICS_TOKEN) or route requires auth — not a pass"
    # Pre-#714 images may 401 via global auth; treat as incomplete verify
    FAIL=1
  elif [[ "$code" == "404" ]]; then
    echo "  WARN: completion probe not deployed yet (merge/deploy PR #714)"
    FAIL=1
  elif [[ "$code" != "200" ]]; then
    echo "  FAIL: unexpected status"
    FAIL=1
  else
    local ok
    ok="$(echo "$body" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("completionProbe") or {}).get("ok", False))' 2>/dev/null || echo False)"
    if [[ "$ok" == "True" || "$ok" == "true" ]]; then
      echo "  OK: completionProbe.ok=true"
    else
      echo "  FAIL: completionProbe.ok is not true"
      FAIL=1
    fi
  fi
}

check_host "Development" "$DEV_API_URL"
check_host "production" "$PROD_API_URL"

echo ""
if [[ "$FAIL" -ne 0 ]]; then
  echo "RESULT: FAIL — fix AI_* on both Railway environments (docs/runbooks/live-ai-restore.md)"
  echo "  ./scripts/apply-railway-ai-profile.sh a   # or b"
  exit 1
fi
echo "RESULT: OK — Development and production AI paths look healthy"
exit 0
