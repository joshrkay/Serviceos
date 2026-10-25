#!/usr/bin/env bash
#
# Deterministic fixture tests for railway-deploy.sh and wait-for-deployment.sh
# (2026-09-08 deployment-tracking fix). No network access — `railway` is
# stubbed by ./fake-railway, driven entirely by env vars, so every scenario
# below is reproducible in CI.
#
# Run: bash scripts/ci/test/run-tests.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_DIR="$(cd "$HERE/.." && pwd)"

# Expose the fixture as `railway` on PATH without shadowing this
# directory's own descriptive script name.
BIN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wfd-bin.XXXXXX")"
ln -sf "$HERE/fake-railway" "$BIN_DIR/railway"
export PATH="$BIN_DIR:$PATH"

pass=0
fail=0

expect_exit() {
  local desc="$1" want="$2"; shift 2
  local out rc
  set +e
  out="$("$@" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq "$want" ]; then
    echo "PASS: $desc"
    pass=$((pass + 1))
  else
    echo "FAIL: $desc (expected exit $want, got $rc)"
    echo "--- output ---"
    echo "$out"
    echo "--------------"
    fail=$((fail + 1))
  fi
  LAST_OUTPUT="$out"
}

expect_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "PASS: $desc"
    pass=$((pass + 1))
  else
    echo "FAIL: $desc (expected to find: $needle)"
    fail=$((fail + 1))
  fi
}

expect_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "FAIL: $desc (must NOT contain: $needle)"
    fail=$((fail + 1))
  else
    echo "PASS: $desc"
    pass=$((pass + 1))
  fi
}

mk_fixture_dir() {
  mktemp -d "${TMPDIR:-/tmp}/wfd-fixture.XXXXXX"
}

mk_count_file() {
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/wfd-count.XXXXXX")"
  printf '%s/count\n' "$d"
}

echo "=== Regression proof: OLD wait-for-deployment.sh trusts index 0 ==="
{
  old_dir="$(mktemp -d "${TMPDIR:-/tmp}/wfd-old.XXXXXX")"
  OLD_SCRIPT="$old_dir/wait-for-deployment.sh"
  git -C "$CI_DIR/.." show d86c1f415185bd5fdfeee25bd556f1fde599d83d:scripts/ci/wait-for-deployment.sh > "$OLD_SCRIPT" 2>/dev/null || {
    echo "SKIP: could not read pre-fix wait-for-deployment.sh from git HEAD (not fatal to the new-behavior tests below)"
    OLD_SCRIPT=""
  }
  if [ -n "$OLD_SCRIPT" ]; then
    chmod +x "$OLD_SCRIPT"
    dir="$(mk_fixture_dir)"
    # Newer, unrelated deployment (e.g. Railway's own GitHub auto-deploy)
    # sorts first; it is WAITING (never resolves). Our actual target, older
    # in the list, already reached SUCCESS. --limit 1 (the old script's
    # hard-coded limit) only ever sees index 0.
    cat > "$dir/0.json" <<'JSON'
[
  {"id": "dep-unrelated-newer", "status": "WAITING", "createdAt": "2026-09-08T12:00:05Z"},
  {"id": "dep-target-1", "status": "SUCCESS", "createdAt": "2026-09-08T12:00:00Z"}
]
JSON
    FAKE_LIST_SEQUENCE_DIR="$dir" \
      expect_exit "OLD script times out (index-0 == unrelated WAITING) even though the target already succeeded" 1 \
      "$OLD_SCRIPT" "@serviceos/api" Development 2
  fi
}

echo
echo "=== railway-deploy.sh ==="

echo "--- happy path: prints exactly the deployment id, nothing else ---"
out="$(FAKE_UP_DEPLOYMENT_ID="dep-abc-123" RAILWAY_TOKEN="super-secret-token-marker" \
  "$CI_DIR/railway-deploy.sh" "@serviceos/api" Development)"
if [ "$out" = "dep-abc-123" ]; then
  echo "PASS: stdout is exactly the deployment id"
  pass=$((pass + 1))
else
  echo "FAIL: stdout was '$out', expected 'dep-abc-123'"
  fail=$((fail + 1))
fi

echo "--- secret token never appears in captured output ---"
full_out="$(FAKE_UP_DEPLOYMENT_ID="dep-abc-123" RAILWAY_TOKEN="super-secret-token-marker" \
  "$CI_DIR/railway-deploy.sh" "@serviceos/api" Development 2>&1)"
expect_not_contains "railway-deploy.sh output never leaks RAILWAY_TOKEN" "super-secret-token-marker" "$full_out"

echo "--- 'railway up' hard failure propagates (non-zero exit) ---"
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='{"error":"build queue rejected"}' \
  expect_exit "railway-deploy.sh fails when 'railway up' exits non-zero" 1 \
  "$CI_DIR/railway-deploy.sh" "@serviceos/api" Development

echo "--- missing deploymentId fails closed (no guessing) ---"
FAKE_UP_STDOUT='{"logsUrl":"https://example.invalid/logs/x"}' \
  expect_exit "railway-deploy.sh fails closed when deploymentId is absent" 1 \
  "$CI_DIR/railway-deploy.sh" "@serviceos/api" Development

echo "--- null deploymentId fails closed ---"
FAKE_UP_STDOUT='{"deploymentId":null,"logsUrl":"https://example.invalid/logs/x"}' \
  expect_exit "railway-deploy.sh fails closed when deploymentId is null" 1 \
  "$CI_DIR/railway-deploy.sh" "@serviceos/api" Development

echo "--- multi-line stdout (ambiguous / non-unique) fails closed ---"
FAKE_UP_STDOUT="$(printf '{"deploymentId":"dep-1"}\n{"deploymentId":"dep-2"}\n')" \
  expect_exit "railway-deploy.sh fails closed on more than one JSON line" 1 \
  "$CI_DIR/railway-deploy.sh" "@serviceos/api" Development

echo
echo "=== wait-for-deployment.sh (new: filters by exact id) ==="

echo "--- target succeeds while a newer unrelated deployment is still waiting ---"
dir="$(mk_fixture_dir)"
cat > "$dir/0.json" <<'JSON'
[
  {"id": "dep-unrelated-newer", "status": "WAITING", "createdAt": "2026-09-08T12:00:05Z"},
  {"id": "dep-target-1", "status": "SUCCESS", "createdAt": "2026-09-08T12:00:00Z"}
]
JSON
FAKE_LIST_SEQUENCE_DIR="$dir" \
  expect_exit "target SUCCESS found despite a newer unrelated WAITING entry sorting first" 0 \
  "$CI_DIR/wait-for-deployment.sh" "@serviceos/api" Development "dep-target-1" 2

echo "--- unrelated SUCCESS cannot mask target FAILED ---"
dir="$(mk_fixture_dir)"
cat > "$dir/0.json" <<'JSON'
[
  {"id": "dep-unrelated-newer", "status": "SUCCESS", "createdAt": "2026-09-08T12:00:05Z"},
  {"id": "dep-target-1", "status": "FAILED", "createdAt": "2026-09-08T12:00:00Z"}
]
JSON
FAKE_LIST_SEQUENCE_DIR="$dir" \
  expect_exit "target FAILED is reported even though an unrelated deployment is SUCCESS" 1 \
  "$CI_DIR/wait-for-deployment.sh" "@serviceos/api" Development "dep-target-1" 2

echo "--- missing target (id never appears) fails closed on timeout ---"
dir="$(mk_fixture_dir)"
cat > "$dir/0.json" <<'JSON'
[
  {"id": "dep-someone-else", "status": "SUCCESS", "createdAt": "2026-09-08T12:00:00Z"}
]
JSON
FAKE_LIST_SEQUENCE_DIR="$dir" WAIT_FOR_DEPLOYMENT_INTERVAL_SECONDS=1 \
  expect_exit "wait-for-deployment.sh times out (not a pass) when the target id never appears" 1 \
  "$CI_DIR/wait-for-deployment.sh" "@serviceos/api" Development "dep-target-1" 2
expect_contains "timeout-on-missing-target message says the target never appeared" \
  "never appeared" "$LAST_OUTPUT"

echo "--- CLI errors (non-zero exit) are tolerated as transient, not a crash or a false pass ---"
FAKE_LIST_EXIT_CODE=1 WAIT_FOR_DEPLOYMENT_INTERVAL_SECONDS=1 \
  expect_exit "wait-for-deployment.sh survives a persistently-failing 'railway' CLI and still fails closed" 1 \
  "$CI_DIR/wait-for-deployment.sh" "@serviceos/api" Development "dep-target-1" 2

echo "--- garbage (non-JSON) CLI output is tolerated as transient, not a crash ---"
FAKE_LIST_GARBAGE="not json at all" WAIT_FOR_DEPLOYMENT_INTERVAL_SECONDS=1 \
  expect_exit "wait-for-deployment.sh survives malformed CLI output and still fails closed" 1 \
  "$CI_DIR/wait-for-deployment.sh" "@serviceos/api" Development "dep-target-1" 2

echo "--- SKIPPED is a pass, but only for the exact target id ---"
dir="$(mk_fixture_dir)"
cat > "$dir/0.json" <<'JSON'
[
  {"id": "dep-target-1", "status": "SKIPPED", "createdAt": "2026-09-08T12:00:00Z"}
]
JSON
FAKE_LIST_SEQUENCE_DIR="$dir" \
  expect_exit "SKIPPED on the target id exits 0" 0 \
  "$CI_DIR/wait-for-deployment.sh" "@serviceos/api" Development "dep-target-1" 2

echo "--- eventual SUCCESS across polling ticks (BUILDING -> DEPLOYING -> SUCCESS) ---"
dir="$(mk_fixture_dir)"
cat > "$dir/0.json" <<'JSON'
[{"id": "dep-target-1", "status": "BUILDING", "createdAt": "2026-09-08T12:00:00Z"}]
JSON
cat > "$dir/1.json" <<'JSON'
[{"id": "dep-target-1", "status": "DEPLOYING", "createdAt": "2026-09-08T12:00:00Z"}]
JSON
cat > "$dir/2.json" <<'JSON'
[{"id": "dep-target-1", "status": "SUCCESS", "createdAt": "2026-09-08T12:00:00Z"}]
JSON
FAKE_LIST_SEQUENCE_DIR="$dir" FAKE_LIST_CALL_COUNT_FILE="$(mk_count_file)" WAIT_FOR_DEPLOYMENT_INTERVAL_SECONDS=1 \
  expect_exit "settles on SUCCESS after transitioning through BUILDING/DEPLOYING" 0 \
  "$CI_DIR/wait-for-deployment.sh" "@serviceos/api" Development "dep-target-1" 10
expect_contains "polling log shows the BUILDING -> DEPLOYING -> SUCCESS progression" \
  "status: DEPLOYING" "$LAST_OUTPUT"

echo "--- a build failure (target FAILED before ever reaching DEPLOYING) is caught ---"
dir="$(mk_fixture_dir)"
cat > "$dir/0.json" <<'JSON'
[{"id": "dep-target-1", "status": "BUILDING", "createdAt": "2026-09-08T12:00:00Z"}]
JSON
cat > "$dir/1.json" <<'JSON'
[{"id": "dep-target-1", "status": "FAILED", "createdAt": "2026-09-08T12:00:00Z"}]
JSON
FAKE_LIST_SEQUENCE_DIR="$dir" FAKE_LIST_CALL_COUNT_FILE="$(mk_count_file)" WAIT_FOR_DEPLOYMENT_INTERVAL_SECONDS=1 \
  expect_exit "build failure on the target id is caught as FAILED" 1 \
  "$CI_DIR/wait-for-deployment.sh" "@serviceos/api" Development "dep-target-1" 10
expect_contains "build-failure message names status FAILED, not just a generic timeout" \
  "ended in status 'FAILED'" "$LAST_OUTPUT"

FAKE_RAILWAY_SLEEP=5 RAILWAY_UPLOAD_TIMEOUT_SECONDS=1 \
  expect_exit "hung upload fails within command budget" 1 \
  "$CI_DIR/railway-deploy.sh" "@serviceos/api" Development
FAKE_RAILWAY_SLEEP=5 WAIT_FOR_DEPLOYMENT_INTERVAL_SECONDS=0 \
  expect_exit "hung list is bounded by overall deadline" 1 \
  "$CI_DIR/wait-for-deployment.sh" "@serviceos/api" Development "dep-target-1" 1
FAKE_UP_STDOUT='{"deploymentId":{"bad":true}}' \
  expect_exit "object ID is rejected" 1 \
  "$CI_DIR/railway-deploy.sh" "@serviceos/api" Development
FAKE_UP_STDOUT='{"deploymentId":"bad\\nvalue"}' \
  expect_exit "unsafe output ID is rejected" 1 \
  "$CI_DIR/railway-deploy.sh" "@serviceos/api" Development

echo
echo "=== railway-deploy.sh: a failed upload shows the Railway CLI's redacted stderr ==="

# Runs railway-deploy.sh with stdout and stderr kept apart: the workflow
# captures stdout as the deployment id, so diagnostics may only ever land on
# stderr. Sets DEPLOY_RC, DEPLOY_STDOUT_FILE, DEPLOY_STDERR_FILE, DEPLOY_STDERR.
# Any arguments are a command prefix to run the script under (e.g. timeout 10).
RUN_DIR_BASE="${TMPDIR:-/tmp}"
run_deploy() {
  local d
  d="$(mktemp -d "$RUN_DIR_BASE/rd-run.XXXXXX")"
  DEPLOY_STDOUT_FILE="$d/stdout"
  DEPLOY_STDERR_FILE="$d/stderr"
  set +e
  "$@" "$CI_DIR/railway-deploy.sh" "@serviceos/api" Development >"$DEPLOY_STDOUT_FILE" 2>"$DEPLOY_STDERR_FILE"
  DEPLOY_RC=$?
  set -e
  DEPLOY_STDERR="$(cat "$DEPLOY_STDERR_FILE")"
}

expect_true() {
  local desc="$1"; shift
  if "$@"; then
    echo "PASS: $desc"
    pass=$((pass + 1))
  else
    echo "FAIL: $desc"
    echo "--- stderr ---"
    printf '%s\n' "$DEPLOY_STDERR"
    echo "--------------"
    fail=$((fail + 1))
  fi
}

# Exact whole-line match (a substring match would also accept a line with
# extra text glued onto it).
expect_line() {
  local desc="$1" line="$2" file="$3"
  if grep -qxF -- "$line" "$file"; then
    echo "PASS: $desc"
    pass=$((pass + 1))
  else
    echo "FAIL: $desc (expected the exact line: $line)"
    fail=$((fail + 1))
  fi
}

# No 4-char run of the secret (whitespace removed from both; all of a
# shorter secret) appears anywhere in the file, the fixed text included.
expect_no_window() {
  local desc="$1" secret="$2" file="$3" flat i n
  flat="$(tr -d '[:space:]' <"$file")"
  secret="$(printf '%s' "$secret" | tr -d '[:space:]')"
  n=4
  [ "${#secret}" -ge "$n" ] || n="${#secret}"
  for ((i = 0; i + n <= ${#secret}; i++)); do
    if [[ "$flat" == *"${secret:i:n}"* ]]; then
      echo "FAIL: $desc (a ${n}-char run of the secret, at offset $i, is printed)"
      fail=$((fail + 1))
      return
    fi
  done
  echo "PASS: $desc"
  pass=$((pass + 1))
}

GENERIC_ERROR="::error::Railway upload failed or timed out for '@serviceos/api' in 'Development'."
WITHHELD="::error::The Railway CLI's stderr could not be redacted, so it is withheld."

echo "--- CLI error (expired/invalid token): its message is shown, on stderr only ---"
private_tmp="$(mktemp -d "${TMPDIR:-/tmp}/rd-tmp.XXXXXX")"
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' TMPDIR="$private_tmp" RAILWAY_TOKEN="super-secret-token-marker" \
  FAKE_UP_STDERR="Invalid RAILWAY_TOKEN. Please check that it is valid and has access to the resource you're trying to use."$'\n' \
  run_deploy
expect_true "CLI error exits 1" [ "$DEPLOY_RC" -eq 1 ]
expect_line "the CLI's auth error is printed as a prefixed ::error:: line" \
  "::error::Railway CLI: Invalid RAILWAY_TOKEN. Please check that it is valid and has access to the resource you're trying to use." "$DEPLOY_STDERR_FILE"
expect_contains "the CLI's exit status is named" "'railway up' exited with status 1 for '@serviceos/api' in 'Development'" "$DEPLOY_STDERR"
expect_not_contains "a CLI error is not reported as a timeout" "timed out after" "$DEPLOY_STDERR"
expect_line "the existing generic error line is still printed" "$GENERIC_ERROR" "$DEPLOY_STDERR_FILE"
expect_true "nothing lands on stdout (the workflow captures it as the deployment id)" [ ! -s "$DEPLOY_STDOUT_FILE" ]
expect_true "the raw stderr capture file does not outlive the script" [ -z "$(ls -A "$private_tmp")" ]

echo "--- the RAILWAY_TOKEN literal never appears: plain, in a URL, in a header, split across a line ---"
# Regex metacharacters, and no 24+ char [A-Za-z0-9_-] run, so ONLY the
# literal-value redaction (not the generic secret-shape rule) can catch it.
tok_a='rwtok.Alpha+7Q'
tok_b='/Omega*[9z]^=end'
tok="$tok_a$tok_b"
api_tok='apitok.K3y+(x)?'
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN="$tok" RAILWAY_API_TOKEN="$api_tok" \
  FAKE_UP_STDERR="$(printf '%s\n' \
    "plain: token $tok was rejected" \
    "url: GET https://backboard.railway.invalid/graphql/v2?token=$tok&project=p failed" \
    "header: Authorization: Bearer $tok" \
    "api: RAILWAY_API_TOKEN is $api_tok here" \
    "wrapped: $tok_a" \
    "$tok_b (continued)")" \
  run_deploy
expect_line "plain occurrence is redacted in place" "::error::Railway CLI: plain: token [REDACTED] was rejected" "$DEPLOY_STDERR_FILE"
expect_line "URL occurrence is redacted in place" "::error::Railway CLI: url: GET https://backboard.railway.invalid/graphql/v2?token=[REDACTED]&project=p failed" "$DEPLOY_STDERR_FILE"
expect_line "Authorization header value is redacted" "::error::Railway CLI: header: Authorization: [REDACTED]" "$DEPLOY_STDERR_FILE"
expect_line "RAILWAY_API_TOKEN literal is redacted too" "::error::Railway CLI: api: RAILWAY_API_TOKEN is [REDACTED] here" "$DEPLOY_STDERR_FILE"
expect_line "a token split across a line break is redacted as a whole" "::error::Railway CLI: wrapped: [REDACTED] (continued)" "$DEPLOY_STDERR_FILE"
expect_not_contains "RAILWAY_TOKEN literal never appears" "$tok" "$DEPLOY_STDERR"
expect_not_contains "neither half of the split RAILWAY_TOKEN appears (first half)" "$tok_a" "$DEPLOY_STDERR"
expect_not_contains "neither half of the split RAILWAY_TOKEN appears (second half)" "$tok_b" "$DEPLOY_STDERR"
expect_not_contains "no prefix of RAILWAY_TOKEN appears" "rwtok" "$DEPLOY_STDERR"
expect_not_contains "RAILWAY_API_TOKEN literal never appears" "apitok" "$DEPLOY_STDERR"

echo "--- secret-looking values are redacted even when they are not RAILWAY_TOKEN ---"
# The token shares no 4-char run with this output (unlike, say,
# 'unrelated-token-value', whose 'toke' is in 'access_token'), so the
# fail-closed fragment check does not withhold it.
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN="Kq7.Vw3/Zx9" \
  FAKE_UP_STDERR="$(printf '%s\n' \
    "Error: key fakesecret0123456789abcdefXYZ rejected for project 3f2a9c1e-7b4d-4e8a-9f10-abcdef123456 (service @serviceos/api)" \
    "proxy said: bearer shortval9 denied" \
    "callback https://example.invalid/cb?access_token=short1&x=1")" \
  run_deploy
expect_line "24+ char secret-shaped runs (incl. a UUID) are redacted, ordinary words kept" \
  "::error::Railway CLI: Error: key [REDACTED] rejected for project [REDACTED] (service @serviceos/api)" "$DEPLOY_STDERR_FILE"
expect_line "a bearer credential is redacted" "::error::Railway CLI: proxy said: bearer [REDACTED] denied" "$DEPLOY_STDERR_FILE"
expect_line "a token=value query parameter is redacted" "::error::Railway CLI: callback https://example.invalid/cb?access_token=[REDACTED]&x=1" "$DEPLOY_STDERR_FILE"
expect_not_contains "the long secret never appears" "fakesecret0123456789abcdefXYZ" "$DEPLOY_STDERR"
expect_not_contains "the short bearer value never appears" "shortval9" "$DEPLOY_STDERR"

echo "--- ANSI escapes and control characters are stripped; a CR cannot smuggle a workflow command ---"
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' \
  FAKE_UP_STDERR="$(printf '\033[31m\033[1mError:\033[0m Service \033[4m@serviceos/api\033[0m not found\a\n\033]0;title\a\rspinner\r::add-mask::injected\n')" \
  run_deploy
expect_line "ANSI-coloured error text is shown as plain text" "::error::Railway CLI: Error: Service @serviceos/api not found" "$DEPLOY_STDERR_FILE"
expect_not_contains "no ESC byte survives" $'\033' "$DEPLOY_STDERR"
expect_not_contains "no BEL byte survives" $'\a' "$DEPLOY_STDERR"
expect_not_contains "no CR byte survives" $'\r' "$DEPLOY_STDERR"
expect_true "CLI text never starts a line (so it cannot issue a workflow command)" \
  [ "$(grep -c '^::add-mask::' "$DEPLOY_STDERR_FILE")" -eq 0 ]

echo "--- more than 20 lines: only the tail (where the error is) is shown ---"
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' \
  FAKE_UP_STDERR="$(for i in $(seq -w 1 25); do echo "cli line $i"; done)" \
  run_deploy
expect_line "the last line is shown" "::error::Railway CLI: cli line 25" "$DEPLOY_STDERR_FILE"
expect_line "the 20th-from-last line is shown" "::error::Railway CLI: cli line 06" "$DEPLOY_STDERR_FILE"
expect_not_contains "lines before the last 20 are dropped" "cli line 05" "$DEPLOY_STDERR"
expect_true "exactly 20 CLI lines are printed" [ "$(grep -c '^::error::Railway CLI: ' "$DEPLOY_STDERR_FILE")" -eq 20 ]
expect_contains "the omission is stated" "5 earlier line(s) omitted" "$DEPLOY_STDERR"

echo "--- a very long line is truncated ---"
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' \
  FAKE_UP_STDERR="$(printf 'segment-%03d ' $(seq 1 100))TAIL-MARKER" \
  run_deploy
expect_contains "the head of the long line is shown" "::error::Railway CLI: segment-001 segment-002" "$DEPLOY_STDERR"
expect_not_contains "the end of the long line is cut" "TAIL-MARKER" "$DEPLOY_STDERR"
expect_contains "the truncation is stated" "chars truncated]" "$DEPLOY_STDERR"
expect_true "no printed line exceeds 400 chars" \
  [ "$(awk '{ if (length($0) > m) m = length($0) } END { print m + 0 }' "$DEPLOY_STDERR_FILE")" -le 400 ]

echo "--- a hung upload is reported as a timeout, with what the CLI printed before it hung ---"
FAKE_UP_STDERR='Indexing...' FAKE_UP_SLEEP=5 RAILWAY_UPLOAD_TIMEOUT_SECONDS=1 run_deploy
expect_true "timeout exits 1" [ "$DEPLOY_RC" -eq 1 ]
expect_contains "the timeout is named as a timeout" "'railway up' timed out after 1s for '@serviceos/api' in 'Development'" "$DEPLOY_STDERR"
expect_not_contains "a timeout is not reported as a CLI exit status" "exited with status" "$DEPLOY_STDERR"
expect_line "the CLI's partial output is shown, without the wrapper's own timeout text glued on" \
  "::error::Railway CLI: Indexing..." "$DEPLOY_STDERR_FILE"
expect_line "the existing generic error line is still printed on timeout" "$GENERIC_ERROR" "$DEPLOY_STDERR_FILE"

echo "--- an escape byte right before the token cannot swallow its first char and expose the rest ---"
# A bare ESC, and a CSI introducer, each consume the 'r' that follows them.
# Regex metacharacters and no 24+ char [A-Za-z0-9_-] run, so ONLY the
# literal-value redaction can catch it.
esc_tok='r.*[x]/&\|$^(?){1}+'
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN="$esc_tok" \
  FAKE_UP_STDERR="$(printf 'bare: x \033%s y\ncsi: x \033[%s y\n' "$esc_tok" "$esc_tok")" \
  run_deploy
expect_true "the bare-ESC line is still shown" grep -q '^::error::Railway CLI: bare: x ' "$DEPLOY_STDERR_FILE"
expect_true "the CSI line is still shown" grep -q '^::error::Railway CLI: csi: x ' "$DEPLOY_STDERR_FILE"
expect_not_contains "the token minus its first char never appears" "${esc_tok#r}" "$DEPLOY_STDERR"
expect_not_contains "no inner fragment of the token appears" '(?){1}' "$DEPLOY_STDERR"

echo "--- a token containing a TAB is redacted although the clean-up turns the TAB into a space ---"
tab_tok=$'tabtok.Left\t+Right'
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN="$tab_tok" \
  FAKE_UP_STDERR="tabbed: $tab_tok here"$'\n' \
  run_deploy
expect_line "a TAB-containing token is redacted in place" "::error::Railway CLI: tabbed: [REDACTED] here" "$DEPLOY_STDERR_FILE"
expect_not_contains "the part before the TAB never appears" "tabtok" "$DEPLOY_STDERR"
expect_not_contains "the part after the TAB never appears" "+Right" "$DEPLOY_STDERR"

echo "--- an escape sequence INSIDE the token: the CLI text is withheld, no 4-char run of the token is printed ---"
# The clean-up eats the escape plus what follows it (a bare ESC or ESC-'('
# its final byte, a CSI introducer up to one, an unterminated OSC the rest
# of the line), so neither literal pass sees the whole token. Regex
# metacharacters and no 24+ char [A-Za-z0-9_-] run, so the shape rules
# cannot catch what is left either: only the fail-closed check can.
in_tok='Mx.*[k]/&\|$^(?){3}+Vq'
for ctl in bare-ESC "ESC-'('" "ESC-'['" "unterminated ESC-']'"; do
  case "$ctl" in
    bare-ESC) seq=$'\033' ;;
    "ESC-'('") seq=$'\033(' ;;
    "ESC-'['") seq=$'\033[' ;;
    *) seq=$'\033]0;' ;;
  esac
  FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN="$in_tok" \
    FAKE_UP_STDERR="auth failed for ${in_tok:0:11}$seq${in_tok:11} (retry)"$'\n' \
    run_deploy
  expect_line "$ctl inside a regex-metachar token: the CLI text is withheld" "$WITHHELD" "$DEPLOY_STDERR_FILE"
  expect_true "$ctl inside a regex-metachar token: no CLI line is printed" \
    [ "$(grep -c '^::error::Railway CLI: ' "$DEPLOY_STDERR_FILE")" -eq 0 ]
  expect_no_window "$ctl inside a regex-metachar token: no 4-char run of it is printed" "$in_tok" "$DEPLOY_STDERR_FILE"
done
expect_line "the generic error line is still printed after a withhold" "$GENERIC_ERROR" "$DEPLOY_STDERR_FILE"
expect_true "an escape-split token still exits 1" [ "$DEPLOY_RC" -eq 1 ]

# A UUID-shaped token: an unterminated OSC eats the rest of the line, so a
# prefix shorter than 24 chars is left (the shape rule misses it): withheld.
# A bare ESC, ESC-'(' or ESC-'[' eats only a few of its 36 chars, so the
# remaining 24+ char run is shape-redacted: rendered, as no 4-char run of
# the token is left.
uuid_tok='7c1e5b2a-04d9-4f3e-8a6b-9d2c1f0e7a35'
for ctl in bare-ESC "ESC-'('" "ESC-'['" "unterminated ESC-']'"; do
  case "$ctl" in
    bare-ESC) seq=$'\033' ;;
    "ESC-'('") seq=$'\033(' ;;
    "ESC-'['") seq=$'\033[' ;;
    *) seq=$'\033]0;' ;;
  esac
  FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN="$uuid_tok" \
    FAKE_UP_STDERR="auth failed for ${uuid_tok:0:13}$seq${uuid_tok:13} (retry)"$'\n' \
    run_deploy
  if [ "$ctl" = "unterminated ESC-']'" ]; then
    expect_line "$ctl inside a UUID-shaped token: the CLI text is withheld" "$WITHHELD" "$DEPLOY_STDERR_FILE"
  else
    expect_line "$ctl inside a UUID-shaped token: shape-redacted and shown" \
      "::error::Railway CLI: auth failed for [REDACTED] (retry)" "$DEPLOY_STDERR_FILE"
  fi
  expect_no_window "$ctl inside a UUID-shaped token: no 4-char run of it is printed" "$uuid_tok" "$DEPLOY_STDERR_FILE"
done

echo "--- a fragment of the token the CLI printed itself is withheld, not shown ---"
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN="$uuid_tok" \
  FAKE_UP_STDERR="Invalid token ${uuid_tok:0:8}... for this project"$'\n' \
  run_deploy
expect_line "a CLI-printed token prefix withholds the CLI text" "$WITHHELD" "$DEPLOY_STDERR_FILE"
expect_no_window "the token prefix is not printed" "$uuid_tok" "$DEPLOY_STDERR_FILE"

echo "--- a '[REDACTED]' the CLI printed itself is CLI text, checked like the rest ---"
# The ESC eats the '7', so the literal passes miss the token; what is left
# starts with the token's own 'k[REDACTED]', which must not pass for the
# helper's placeholder.
bracket_tok='k[REDACTED]7Vq'
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN="$bracket_tok" \
  FAKE_UP_STDERR="auth failed for k[REDACTED]"$'\033'"7Vq (retry)"$'\n' \
  run_deploy
expect_line "a CLI-printed '[REDACTED]' next to the rest of the token withholds the CLI text" "$WITHHELD" "$DEPLOY_STDERR_FILE"
expect_not_contains "the token's tail is not printed" "Vq" "$DEPLOY_STDERR"

echo "--- a benign CLI error that shares no 4-char run with the tokens is shown in full ---"
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN="$uuid_tok" RAILWAY_API_TOKEN="$in_tok" \
  FAKE_UP_STDERR="Unauthorized. Please run 'railway login' or set a valid RAILWAY_TOKEN (status 401)."$'\n' \
  run_deploy
expect_line "the benign error is shown verbatim" \
  "::error::Railway CLI: Unauthorized. Please run 'railway login' or set a valid RAILWAY_TOKEN (status 401)." "$DEPLOY_STDERR_FILE"
expect_not_contains "the benign error is not withheld" "could not be redacted" "$DEPLOY_STDERR"

echo "--- the helper's own fixed text never withholds: placeholder, prefix and notes are not CLI text ---"
# The token shares 4-char runs with '[REDACTED]', the '::error::Railway
# CLI: ' prefix and the truncation / omitted-lines notes (whitespace
# removed), but with nothing the CLI printed.
fixed_tok='z7[REDACTED]::error::RailwayCLI:charstruncated]omitted;showingz'
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN="$fixed_tok" \
  FAKE_UP_STDERR="$(for i in $(seq -w 1 20); do echo "cli line $i"; done; \
    echo "rejected: $fixed_tok retry"; printf 'segment-%03d ' $(seq 1 100))" \
  run_deploy
expect_line "the token is redacted in place, not withheld" \
  "::error::Railway CLI: rejected: [REDACTED] retry" "$DEPLOY_STDERR_FILE"
expect_contains "the truncation note is printed" "chars truncated]" "$DEPLOY_STDERR"
expect_contains "the omitted-lines note is printed" "2 earlier line(s) omitted" "$DEPLOY_STDERR"
expect_not_contains "nothing is withheld" "could not be redacted" "$DEPLOY_STDERR"

echo "--- whitespace inside the secret cannot make redaction super-linear ---"
# Spaces in the secret used to become literal spaces between stacked \s*
# runs, which took minutes on lines of 'a' + 2000 spaces. Run under a 10s
# outer limit (shorter than the helper's own bound) so a regression fails
# here, as exit 124, instead of being hidden by the withheld branch.
hostile="$(for _ in $(seq 1 20); do printf 'a%2000sc\n' ''; done)"
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_TOKEN='a  b' FAKE_UP_STDERR="$hostile" \
  run_deploy timeout 10
expect_true "the run finishes well inside the bound (exit 1, not timeout's 124)" [ "$DEPLOY_RC" -eq 1 ]
expect_line "the CLI's lines are rendered, not withheld" \
  "::error::Railway CLI: a$(printf '%299s' '')... [1702 chars truncated]" "$DEPLOY_STDERR_FILE"
expect_not_contains "the withheld notice is not printed" "could not be redacted" "$DEPLOY_STDERR"

echo "--- a helper that overruns its bound withholds the CLI text, never prints it raw ---"
# 1ms is far less than the helper needs to start, so it is always cut off.
FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_DIAGNOSTICS_TIMEOUT_SECONDS=0.001 \
  FAKE_UP_STDERR="raw-cli-marker-77 Unauthorized"$'\n' \
  run_deploy
expect_true "an overrun helper still exits 1" [ "$DEPLOY_RC" -eq 1 ]
expect_line "the withheld notice is printed" "$WITHHELD" "$DEPLOY_STDERR_FILE"
expect_not_contains "the CLI text is not printed" "raw-cli-marker-77" "$DEPLOY_STDERR"
expect_line "the existing generic error line is still printed when withheld" "$GENERIC_ERROR" "$DEPLOY_STDERR_FILE"
expect_true "nothing lands on stdout when withheld" [ ! -s "$DEPLOY_STDOUT_FILE" ]

echo "--- a RAILWAY_DIAGNOSTICS_TIMEOUT_SECONDS that is not a positive number falls back to the 15s default ---"
# 'timeout 0' would run the helper unbounded, and timeout rejects 'abc' and
# '-1' outright (withholding the text for no reason). A shim in front of
# coreutils timeout records the bound it is actually given.
shim_dir="$(mktemp -d "${TMPDIR:-/tmp}/rd-shim.XXXXXX")"
real_timeout="$(command -v timeout)"
cat >"$shim_dir/timeout" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' "\$1" "\${3##*/}" >>"$shim_dir/bounds"
exec "$real_timeout" "\$@"
EOF
chmod +x "$shim_dir/timeout"
for bad in 0 abc -1; do
  : >"$shim_dir/bounds"
  FAKE_UP_EXIT_CODE=1 FAKE_UP_STDOUT='' RAILWAY_DIAGNOSTICS_TIMEOUT_SECONDS="$bad" PATH="$shim_dir:$PATH" \
    FAKE_UP_STDERR="bound-marker Unauthorized"$'\n' \
    run_deploy
  expect_true "RAILWAY_DIAGNOSTICS_TIMEOUT_SECONDS=$bad: the helper still runs under 'timeout 15'" \
    [ "$(cat "$shim_dir/bounds")" = "15 railway-stderr-diagnostics.py" ]
  expect_line "RAILWAY_DIAGNOSTICS_TIMEOUT_SECONDS=$bad: the CLI's error is still shown" \
    "::error::Railway CLI: bound-marker Unauthorized" "$DEPLOY_STDERR_FILE"
done

echo "--- success path is unchanged: stdout is exactly the id, the CLI's stderr is not echoed ---"
FAKE_UP_DEPLOYMENT_ID="dep-abc-123" RAILWAY_TOKEN="super-secret-token-marker" \
  FAKE_UP_STDERR="Indexing... progress-marker-42"$'\n'"warning: something non-fatal"$'\n' \
  run_deploy
expect_true "success exits 0" [ "$DEPLOY_RC" -eq 0 ]
expect_true "stdout is byte-for-byte 'dep-abc-123\\n'" cmp -s "$DEPLOY_STDOUT_FILE" <(printf 'dep-abc-123\n')
expect_true "stderr is empty (a successful run's CLI stderr is not printed)" [ ! -s "$DEPLOY_STDERR_FILE" ]

echo
echo "=== Results: $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
