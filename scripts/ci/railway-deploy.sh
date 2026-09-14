#!/usr/bin/env bash
#
# 2026-09-08 (deployment-tracking fix) — trigger a Railway deploy and print
# the EXACT deployment ID Railway assigned to this invocation.
#
# Background: `railway up --ci` (no --json, no --detach) never prints a
# deployment ID on stdout — only `--detach --json` does, immediately after
# upload, before the build even starts:
#   {"deploymentId": "<uuid>", "logsUrl": "https://..."}
# (verified against @railway/cli v5.49.6 source, src/commands/up.rs — see
# docs/plans/2026-09-08-deployment-tracking.md). `--detach` returns before
# waiting on build/deploy, so build-failure detection is NOT done here; it
# happens in wait-for-deployment.sh, which polls this exact ID from its
# earliest (QUEUED/BUILDING) status through to a terminal one, so a build
# failure is still caught (as status FAILED) — just by the follow-up poll
# instead of by this command's own exit code.
#
# Fails closed: any non-zero `railway up` exit, or a response with no
# non-empty `.deploymentId`, is a hard failure. Never falls back to
# "guess the latest deployment" — that ambiguity is exactly the bug this
# script exists to remove (a concurrent, unrelated Railway auto-deploy on
# the same service — e.g. its GitHub integration waiting on a CI check —
# can otherwise look like "the newest deployment" and mask this one).
#
# Usage: railway-deploy.sh <service-name> <environment>
# Requires: RAILWAY_TOKEN in the environment, jq.
# On success: prints ONLY the deployment id to stdout (nothing else — safe
# to capture directly, e.g. `id="$(railway-deploy.sh ...)"`, and never
# echoes RAILWAY_TOKEN or raw CLI output that could carry secrets).

set -euo pipefail

SERVICE="${1:-}"
ENVIRONMENT="${2:-}"

if [ -z "$SERVICE" ] || [ -z "$ENVIRONMENT" ]; then
  echo "::error::railway-deploy.sh requires <service-name> <environment>." >&2
  exit 1
fi

stderr_capture="$(mktemp "${TMPDIR:-/tmp}/railway-deploy-stderr.XXXXXX")"
trap 'rm -f "$stderr_capture"' EXIT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
raw="$(python3 "$HERE/railway-command.py" "${RAILWAY_UPLOAD_TIMEOUT_SECONDS:-300}" up --service "$SERVICE" --environment "$ENVIRONMENT" --json --detach 2>/dev/null)" || {
  echo "::error::Railway upload failed or timed out for '$SERVICE' in '$ENVIRONMENT'." >&2
  exit 1
}

# Expect exactly one JSON object on stdout (see comment above). Extract
# .deploymentId; tolerate neither multiple lines nor a missing/null/blank
# value — any of those is "no unique ID" and must fail closed rather than
# proceed with an empty or guessed target.
line_count="$(printf '%s' "$raw" | grep -c '.' || true)"
if [ "$line_count" -ne 1 ]; then
  echo "::error::Expected exactly one JSON line from 'railway up --json --detach' for '$SERVICE' in '$ENVIRONMENT', got ${line_count}. Cannot determine a unique deployment ID." >&2
  exit 1
fi

deployment_id="$(printf '%s' "$raw" | jq -ser 'select(length == 1) | .[0] | select(type == "object") | .deploymentId | select(type == "string") | select(test("^[A-Za-z0-9-]+$"))' 2>/dev/null || true)"

if [ -z "$deployment_id" ] || [ "$deployment_id" = "null" ]; then
  echo "::error::'railway up' for '$SERVICE' in '$ENVIRONMENT' returned no deployment ID. Refusing to guess (e.g. by polling for the newest deployment) — failing closed." >&2
  exit 1
fi

printf '%s\n' "$deployment_id"
