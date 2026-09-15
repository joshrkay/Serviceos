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
echo "=== Results: $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
