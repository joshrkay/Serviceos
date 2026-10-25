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
# Requires: RAILWAY_TOKEN in the environment, jq, coreutils timeout.
# On success: prints ONLY the deployment id to stdout (nothing else — safe
# to capture directly, e.g. `id="$(railway-deploy.sh ...)"`, and never
# echoes RAILWAY_TOKEN or raw CLI output that could carry secrets). The
# CLI's stderr is captured but discarded on success (Railway prints
# progress and warnings there).
# On a failed or timed-out upload, or a response with no usable id: names
# which it was, then prints a redacted, bounded tail of BOTH of the CLI's
# streams as ::error:: lines on stderr, stdout first, each line labelled
# with its stream. Both matter: with --json the CLI reports its own errors
# on stdout, as one JSON object (e.g. {"code":"NOT_AUTHENTICATED",
# "error":"Not signed in.","hint":"..."}), and leaves stderr empty. Each
# stream goes through railway-cli-diagnostics.py in its own run, given at
# most RAILWAY_DIAGNOSTICS_TIMEOUT_SECONDS (a positive number of seconds,
# anything else means the default 15) — so an expired RAILWAY_TOKEN or a
# renamed service/environment is visible in the log instead of only a
# generic failure line. If that run fails, overruns, or finds part of a
# secret it could not redact, that stream's text is withheld instead (with
# a line saying so); the other stream is still shown.

set -euo pipefail

SERVICE="${1:-}"
ENVIRONMENT="${2:-}"

if [ -z "$SERVICE" ] || [ -z "$ENVIRONMENT" ]; then
  echo "::error::railway-deploy.sh requires <service-name> <environment>." >&2
  exit 1
fi

# Both streams go to files: stdout is the deployment id on success, and
# what the CLI said went wrong (its --json error object) on failure.
stdout_capture="$(mktemp "${TMPDIR:-/tmp}/railway-deploy-stdout.XXXXXX")"
trap 'rm -f "$stdout_capture"' EXIT
stderr_capture="$(mktemp "${TMPDIR:-/tmp}/railway-deploy-stderr.XXXXXX")"
trap 'rm -f "$stdout_capture" "$stderr_capture"' EXIT

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prints both captured streams, stdout first, redacted and bounded, as
# ::error:: lines on stderr (never stdout: the workflow captures that as
# the deployment id). Each stream gets its own helper run under its own
# time limit, so one that fails or overruns withholds only itself. The
# helper's stdout goes to our stderr; its own stderr (e.g. a traceback) is
# dropped, and if it fails (it exits 1, printing nothing, when part of a
# secret survived redaction) or overruns its time limit (timeout exits
# 124), that stream's text is withheld. The limit must be a positive
# number: 'timeout 0' would disable it, and a value timeout rejects would
# withhold the text for nothing.
show_cli_output() {
  local diagnostics_timeout stream capture
  diagnostics_timeout="${RAILWAY_DIAGNOSTICS_TIMEOUT_SECONDS:-15}"
  if ! [[ "$diagnostics_timeout" =~ ^[0-9]*\.?[0-9]+$ && "$diagnostics_timeout" =~ [1-9] ]]; then
    diagnostics_timeout=15
  fi
  for stream in stdout stderr; do
    if [ "$stream" = stdout ]; then capture="$stdout_capture"; else capture="$stderr_capture"; fi
    timeout "$diagnostics_timeout" python3 "$HERE/railway-cli-diagnostics.py" "$stream" <"$capture" >&2 2>/dev/null ||
      echo "::error::The Railway CLI's $stream could not be redacted, so it is withheld." >&2
  done
}

upload_timeout="${RAILWAY_UPLOAD_TIMEOUT_SECONDS:-300}"
upload_rc=0
python3 "$HERE/railway-command.py" "$upload_timeout" up --service "$SERVICE" --environment "$ENVIRONMENT" --json --detach >"$stdout_capture" 2>"$stderr_capture" || upload_rc=$?
if [ "$upload_rc" -ne 0 ]; then
  # 124 is railway-command.py's timeout exit (it killed the CLI).
  if [ "$upload_rc" -eq 124 ]; then
    echo "::error::'railway up' timed out after ${upload_timeout}s for '$SERVICE' in '$ENVIRONMENT'. What the Railway CLI printed to stdout and stderr before that (redacted, last lines only) follows." >&2
  else
    echo "::error::'railway up' exited with status $upload_rc for '$SERVICE' in '$ENVIRONMENT'. The Railway CLI's stdout and stderr (redacted, last lines only) follow." >&2
  fi
  show_cli_output
  echo "::error::Railway upload failed or timed out for '$SERVICE' in '$ENVIRONMENT'." >&2
  exit 1
fi
raw="$(<"$stdout_capture")"

# Expect exactly one JSON object on stdout (see comment above). Extract
# .deploymentId; tolerate neither multiple lines nor a missing/null/blank
# value — any of those is "no unique ID" and must fail closed rather than
# proceed with an empty or guessed target.
line_count="$(printf '%s' "$raw" | grep -c '.' || true)"
if [ "$line_count" -ne 1 ]; then
  echo "::error::Expected exactly one JSON line from 'railway up --json --detach' for '$SERVICE' in '$ENVIRONMENT', got ${line_count}. Cannot determine a unique deployment ID. The Railway CLI's stdout and stderr (redacted, last lines only) follow." >&2
  show_cli_output
  exit 1
fi

deployment_id="$(printf '%s' "$raw" | jq -ser 'select(length == 1) | .[0] | select(type == "object") | .deploymentId | select(type == "string") | select(test("^[A-Za-z0-9-]+$"))' 2>/dev/null || true)"

if [ -z "$deployment_id" ] || [ "$deployment_id" = "null" ]; then
  echo "::error::'railway up' for '$SERVICE' in '$ENVIRONMENT' returned no deployment ID. Refusing to guess (e.g. by polling for the newest deployment) — failing closed. The Railway CLI's stdout and stderr (redacted, last lines only) follow." >&2
  show_cli_output
  exit 1
fi

printf '%s\n' "$deployment_id"
