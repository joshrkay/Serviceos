#!/usr/bin/env bash
#
# QUALITY-2026-07-12 (PR #669 review) — wait for the LATEST Railway deployment
# of a service to reach SUCCESS.
#
# `railway up --ci` streams build logs and exits after the BUILD, but the
# deployment (preDeployCommand migration + container swap + Railway's own
# healthcheck) continues in the background. Polling the public URL alone can
# green against the still-healthy OLD container while the new rollout is in
# flight or has FAILED (Railway keeps prior traffic on failure). This script
# closes that race by polling `railway deployment list --json` for the
# service's newest deployment until it is SUCCESS, failing hard on
# FAILED/CRASHED/REMOVED or timeout. The health poll + smoke that follow then
# verify the NEW deployment is actually serving.
#
# Usage: wait-for-deployment.sh <service-name> <environment> [timeout-seconds]
# Requires: RAILWAY_TOKEN in the environment (same as `railway up`), jq.

set -euo pipefail

SERVICE="${1:-}"
ENVIRONMENT="${2:-}"
TIMEOUT_SECONDS="${3:-600}"
INTERVAL_SECONDS=10

if [ -z "$SERVICE" ] || [ -z "$ENVIRONMENT" ]; then
  echo "::error::wait-for-deployment.sh requires <service-name> <environment>."
  exit 1
fi

echo "Waiting for the latest '$SERVICE' deployment in '$ENVIRONMENT' to reach SUCCESS (timeout ${TIMEOUT_SECONDS}s)..."

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
last_status=""

while [ "$(date +%s)" -lt "$deadline" ]; do
  # Newest-first list; take the first entry's status. Tolerate both a bare
  # array and an object-wrapped shape.
  raw="$(railway deployment list --service "$SERVICE" --environment "$ENVIRONMENT" --json --limit 1 2>/dev/null || true)"
  status="$(printf '%s' "$raw" | jq -r 'if type == "array" then .[0].status // empty else (.deployments[0].status // .[0].status // empty) end' 2>/dev/null || true)"

  if [ -n "$status" ] && [ "$status" != "$last_status" ]; then
    echo "  latest deployment status: $status"
    last_status="$status"
  fi

  case "$status" in
    SUCCESS)
      echo "Deployment SUCCESS for '$SERVICE'."
      exit 0
      ;;
    FAILED|CRASHED|REMOVED)
      echo "::error::Deployment for '$SERVICE' ended in status '$status'. The previous container may still be serving traffic — this deploy is NOT green."
      exit 1
      ;;
  esac

  sleep "$INTERVAL_SECONDS"
done

echo "::error::Timed out after ${TIMEOUT_SECONDS}s waiting for '$SERVICE' deployment to reach SUCCESS (last status: ${last_status:-unknown})."
exit 1
