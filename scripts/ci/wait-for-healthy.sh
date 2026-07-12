#!/usr/bin/env bash
#
# WS7 (QUALITY-2026-07-12) — post-deploy health poll.
#
# `railway up --detach` returns before the new container is healthy, so the
# deploy workflow calls this to WAIT for the just-deployed API to report
# healthy before declaring the deploy green (and before promoting dev → prod).
#
# Polls GET <base>/health until the body contains "status":"ok" or the timeout
# elapses. /health always returns HTTP 200 while the process is up but reports
# "degraded"/"down" in the JSON body when the DB/cache are unreachable (see
# packages/api/src/health/health.ts) — so a status-code check alone would
# green-light a DB-degraded deploy. We match the body instead, mirroring
# packages/api/scripts/smoke-test.ts.
#
# Exits 0 as soon as the service is healthy, non-zero (with the last body
# printed) on timeout. A missing/blank base URL is a hard error — callers must
# guard for that before invoking, but we double-check here so this script can
# never silently "succeed" against an empty target.
#
# Usage: wait-for-healthy.sh <base-url> [timeout-seconds] [interval-seconds]

set -euo pipefail

BASE="${1:-}"
TIMEOUT_SECONDS="${2:-300}" # ~5 minutes
INTERVAL_SECONDS="${3:-10}"

if [ -z "$BASE" ]; then
  echo "::error::wait-for-healthy.sh called with no base URL — cannot verify a deploy against an empty target."
  exit 1
fi

# Normalise: strip a trailing slash so "$BASE/health" is well-formed.
BASE="${BASE%/}"
HEALTH_URL="$BASE/health"

echo "Waiting for $HEALTH_URL to report healthy (timeout ${TIMEOUT_SECONDS}s, interval ${INTERVAL_SECONDS}s)..."

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
last_body=""
attempt=0

while [ "$(date +%s)" -lt "$deadline" ]; do
  attempt=$((attempt + 1))
  # -s silent, -S show errors, --max-time bounds a hung connection so a
  # stalled SYN can't eat the whole timeout in one attempt.
  if last_body="$(curl -sS --max-time 10 "$HEALTH_URL" 2>&1)"; then
    # Parse the TOP-LEVEL .status only (PR #669 review): the body nests
    # per-check statuses (e.g. "drain":{"status":"ok"}), so a substring grep
    # for "status":"ok" would pass on a DB-down body whose top-level status
    # is "down". jq is present on GitHub runners; a parse failure counts as
    # not-healthy rather than a pass.
    top_status="$(printf '%s' "$last_body" | jq -r '.status // empty' 2>/dev/null || true)"
    if [ "$top_status" = "ok" ]; then
      echo "  healthy after ${attempt} attempt(s): $last_body"
      exit 0
    fi
    echo "  attempt ${attempt}: not healthy yet (top-level status: ${top_status:-unparseable}) — $last_body"
  else
    echo "  attempt ${attempt}: request failed — $last_body"
  fi
  sleep "$INTERVAL_SECONDS"
done

echo "::error::Deploy did not become healthy within ${TIMEOUT_SECONDS}s. Last response from ${HEALTH_URL}: ${last_body}"
exit 1
