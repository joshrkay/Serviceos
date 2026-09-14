#!/usr/bin/env bash
#
# QUALITY-2026-07-12 (PR #669 review) — wait for a specific Railway
# deployment to reach a terminal status.
#
# 2026-09-08 (deployment-tracking fix): this used to poll `railway
# deployment list --json --limit 1` and trust index 0 ("the newest
# deployment"). That is unsound whenever more than one deployment can exist
# for the same service around the same time — e.g. this service also has
# Railway's GitHub auto-deploy configured, and a push to main queues its own
# (unrelated) deployment that can sit newer-but-WAITING/QUEUED while the
# deployment this workflow actually triggered (via `railway up`) already
# reached SUCCESS. Polling "newest" then reports the wrong deployment's
# status — including reporting a false failure, or a false pass, for a
# deploy this workflow never made.
#
# Fix: require the caller to pass the EXACT deployment ID (from
# railway-deploy.sh, which captures it straight off `railway up --json
# --detach`'s own response — see that script's header and
# docs/plans/2026-09-08-deployment-tracking.md). This script then filters
# `railway deployment list --json` for that id specifically, ignoring
# position/recency entirely. `railway deployment list` has no per-ID filter
# flag (verified against @railway/cli v5.49.6 source), so filtering
# client-side over a generous --limit is the correct use of the documented
# interface. A deployment id that never appears in that window is treated
# the same as any other non-terminal outcome: keep polling until the
# timeout, then fail closed — never silently proceed.
#
# Because this ID is captured immediately after upload (before the build
# starts), polling it from here also covers build failures: a bad build
# lands this same id in FAILED before it ever reaches DEPLOYING.
#
# SKIPPED is also treated as a pass, but "pass" here means only "this run
# did not fail" — it is NOT proof that the just-pushed commit is live.
# Railway reports SKIPPED when it detects no changes under this service's
# configured watch paths for the deployed commit, so it deliberately does
# not build or deploy a new container — the existing (already-SUCCESS)
# deployment keeps serving traffic unchanged. There is no new rollout in
# flight, so the FAILED/CRASHED race this script guards against does not
# apply; the health poll + smoke test that follow still confirm the service
# is actually up, honestly, regardless of which revision is serving it.
# (2026-07-17 incident: two consecutive prod deploys for the same commit
# timed out after 600s each because this script had no terminal case for
# SKIPPED and kept polling until the deadline.)
#
# Usage: wait-for-deployment.sh <service-name> <environment> <deployment-id> [timeout-seconds]
# Requires: RAILWAY_TOKEN in the environment (same as `railway up`), jq.

set -euo pipefail

SERVICE="${1:-}"
ENVIRONMENT="${2:-}"
DEPLOYMENT_ID="${3:-}"
TIMEOUT_SECONDS="${4:-600}"
INTERVAL_SECONDS="${WAIT_FOR_DEPLOYMENT_INTERVAL_SECONDS:-10}"
LIST_LIMIT="${WAIT_FOR_DEPLOYMENT_LIST_LIMIT:-30}"

if [ -z "$SERVICE" ] || [ -z "$ENVIRONMENT" ] || [ -z "$DEPLOYMENT_ID" ]; then
  echo "::error::wait-for-deployment.sh requires <service-name> <environment> <deployment-id>." >&2
  exit 1
fi

echo "Waiting for deployment '$DEPLOYMENT_ID' ('$SERVICE' in '$ENVIRONMENT') to reach a terminal status (timeout ${TIMEOUT_SECONDS}s)..."

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
last_status=""
last_seen=0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ "$(date +%s)" -lt "$deadline" ]; do
  remaining=$(( deadline - $(date +%s) ))
  command_limit=30
  if [ "$remaining" -lt "$command_limit" ]; then command_limit="$remaining"; fi
  raw="$(python3 "$HERE/railway-command.py" "$command_limit" deployment list --service "$SERVICE" --environment "$ENVIRONMENT" --json --limit "$LIST_LIMIT" 2>/dev/null || true)"

  # Tolerate both a bare array and an object-wrapped shape, and select the
  # entry matching our exact deployment id — never index 0.
  status="$(printf '%s' "$raw" | jq -r --arg id "$DEPLOYMENT_ID" '
      (if type == "array" then . else (.deployments // []) end)
      | map(select(.id == $id)) | .[0].status // empty
    ' 2>/dev/null || true)"

  if [ -n "$status" ]; then
    last_seen=1
    if [ "$status" != "$last_status" ]; then
      echo "  deployment '$DEPLOYMENT_ID' status: $status"
      last_status="$status"
    fi
  fi

  case "$status" in
    SUCCESS)
      echo "Deployment '$DEPLOYMENT_ID' reached SUCCESS for '$SERVICE'."
      exit 0
      ;;
    SKIPPED)
      echo "Railway reports SKIPPED for deployment '$DEPLOYMENT_ID' on '$SERVICE' (no changes detected in its watch paths for this commit). No new build or rollout happened for THIS deployment id — the previously running revision is still serving traffic. Treating as a pass (not as proof the new commit is live); the health poll + smoke test that follow confirm the service is actually up."
      exit 0
      ;;
    FAILED|CRASHED|REMOVED)
      echo "::error::Deployment '$DEPLOYMENT_ID' for '$SERVICE' ended in status '$status'. The previous container may still be serving traffic — this deploy is NOT green." >&2
      exit 1
      ;;
  esac

  sleep "$INTERVAL_SECONDS"
done

if [ "$last_seen" -eq 0 ]; then
  echo "::error::Deployment '$DEPLOYMENT_ID' for '$SERVICE' in '$ENVIRONMENT' never appeared in 'railway deployment list' (limit ${LIST_LIMIT}) within ${TIMEOUT_SECONDS}s. Failing closed — a missing target is not a pass." >&2
else
  echo "::error::Timed out after ${TIMEOUT_SECONDS}s waiting for deployment '$DEPLOYMENT_ID' ('$SERVICE') to reach a terminal status (last status: ${last_status:-unknown})." >&2
fi
exit 1
