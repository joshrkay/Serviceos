#!/usr/bin/env bash
# QA-2026-07-10 Gap — FK-path coverage guard
#
# WHAT IT PROTECTS
# -----------------
# A P0 shipped because the telephony voice-turn processor and the Twilio
# adapter built `proposals` rows with `aiRunId: uuidv4()` — a fabricated
# id with no matching `ai_runs` row. `proposals.ai_run_id` has a real FK
# (`proposals_ai_run_id_fkey`), so every one of those inserts threw on
# Postgres, the error was swallowed, and inbound-voice proposals were
# silently dropped in production. The unit suite that "covered" these
# paths used InMemory*Repository, which does not enforce foreign keys —
# so every test passed while the feature was broken end to end.
#
# This guard cannot know in general whether a DB write is FK-safe (that
# needs a real Postgres and belongs in test/integration/). What it CAN do
# cheaply and reliably, grep-style like check-ai-gateway-guard.sh:
#
#   1. Ban the exact shape of the regression: an `aiRunId`/`ai_run_id`
#      field assigned directly from a fabricated-id generator
#      (uuidv4()/randomUUID()) anywhere in src/. A real ai_run_id must
#      come from a persisted ai_runs row (threaded through from the
#      caller), never minted on the spot.
#   2. Require that every module on the curated allowlist below — code
#      that builds a proposal carrying an ai_run_id on a request/voice
#      path — is referenced by a "FK-PATH-COVERAGE" marker comment in at
#      least one file under test/integration/. That marker is how a real
#      Docker-gated Postgres test declares "I exercise the FK behavior
#      this module depends on." No marker anywhere = the module's FK
#      behavior is only proven by mocked-repo tests = guard fails.
#
# HOW TO SATISFY A FAILURE
# -------------------------
#   - Fabricated-id violation: stop minting the id. Thread a real
#     ai_runs id from the caller, or omit the field so it persists NULL
#     (the FK allows NULL).
#   - Missing coverage marker: either (a) add/extend a real-DB
#     integration test in packages/api/test/integration/ that exercises
#     the module's proposal-writing path against actual Postgres, and
#     add a comment `// FK-PATH-COVERAGE: <path/to/module.ts>` in that
#     test file, referencing every module it covers; or (b) if the
#     module genuinely never writes an FK-bearing column (e.g. it was
#     refactored to not touch ai_run_id at all), remove it from the
#     ALLOWLIST array below with a comment explaining why.
#
# This is intentionally a curated allowlist, not a heuristic that tries
# to auto-discover every proposal-writing call site — a shorter honest
# list beats a longer list full of false positives/negatives. When you
# add a new code path that assigns ai_run_id on a proposal (or similar
# FK-bearing column), add it to ALLOWLIST in the same PR.
#
# Usage:
#   ./scripts/check-fk-path-coverage.sh [extra-src-dir] [extra-test-dir]
#
#   extra-src-dir / extra-test-dir let a self-check plant a violation in
#   a temp directory without touching the real tree (mirrors the
#   extra-dir pattern in check-ai-gateway-guard.sh).
#
# Exit codes:
#   0 — no fabricated-id violations, all allowlisted modules covered
#   1 — one or more violations found (build should fail)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SCRIPT_DIR}/../src"
TEST_INTEGRATION_DIR="${SCRIPT_DIR}/../test/integration"

EXTRA_SRC_DIR="${1:-}"
EXTRA_TEST_DIR="${2:-}"

SEARCH_SRC_PATHS=("${SRC_DIR}")
if [ -n "${EXTRA_SRC_DIR}" ]; then
  SEARCH_SRC_PATHS+=("${EXTRA_SRC_DIR}")
fi

SEARCH_TEST_PATHS=("${TEST_INTEGRATION_DIR}")
if [ -n "${EXTRA_TEST_DIR}" ]; then
  SEARCH_TEST_PATHS+=("${EXTRA_TEST_DIR}")
fi

OFFENDERS=()

# --- Part 1: ban fabricated ai_run_id / aiRunId assignment -----------------
#
# Matches the exact regression shape:
#   aiRunId: uuidv4()
#   aiRunId: randomUUID()
#   aiRunId: crypto.randomUUID()
#   ai_run_id: uuidv4()   (raw column-name spelling, belt-and-suspenders)
FABRICATED_ID_PATTERN='(aiRunId|ai_run_id)[[:space:]]*:[[:space:]]*(uuidv4|randomUUID|crypto\.randomUUID)\('

for search_path in "${SEARCH_SRC_PATHS[@]}"; do
  while IFS= read -r -d '' file; do
    if grep -qE "${FABRICATED_ID_PATTERN}" "${file}" 2>/dev/null; then
      rel="${file#${SCRIPT_DIR}/../}"
      match="$(grep -E "${FABRICATED_ID_PATTERN}" "${file}" | head -1 | sed -e 's/^[[:space:]]*//')"
      OFFENDERS+=("[fabricated-id] ${rel}: '${match}' -- proposals.ai_run_id has an FK to ai_runs(id); never mint this value, thread a real ai_runs id or omit the field")
    fi
  done < <(find "${search_path}" \( -name "*.ts" -o -name "*.tsx" \) -not -name "*.test.ts" -print0 2>/dev/null)
done

# --- Part 2: curated allowlist of paths that MUST have integration coverage
#
# Every module here builds a proposal (or similar FK-bearing entity) with
# an ai_run_id on a request/voice path. Each one must be named in a
# `FK-PATH-COVERAGE:` marker comment somewhere under test/integration/.
ALLOWLIST=(
  "src/ai/voice-turn/create-voice-turn-processor.ts"
  "src/telephony/twilio-adapter.ts"
  "src/ai/agents/customer-calling/inapp-adapter.ts"
  "src/proposals/pg-proposal.ts"
)

for module in "${ALLOWLIST[@]}"; do
  found=0
  for test_path in "${SEARCH_TEST_PATHS[@]}"; do
    if [ -d "${test_path}" ]; then
      if grep -rlF "FK-PATH-COVERAGE: ${module}" "${test_path}" >/dev/null 2>&1; then
        found=1
        break
      fi
    fi
  done
  if [ "${found}" -ne 1 ]; then
    OFFENDERS+=("[missing-coverage] ${module}: no 'FK-PATH-COVERAGE: ${module}' marker found in any test/integration/*.ts file -- this path's FK behavior is only proven by mocked-repo unit tests. Add a real-DB integration test and mark it, or justify removing this module from ALLOWLIST in check-fk-path-coverage.sh")
  fi
done

if [ ${#OFFENDERS[@]} -gt 0 ]; then
  echo "[fk-path-coverage] FAIL:" >&2
  for item in "${OFFENDERS[@]}"; do
    echo "  - ${item}" >&2
  done
  echo "" >&2
  echo "See packages/api/scripts/check-fk-path-coverage.sh header for what this protects and how to satisfy it." >&2
  exit 1
fi

echo "[fk-path-coverage] OK: no fabricated ai_run_id assignments; all allowlisted FK-writing paths have integration coverage markers."
exit 0
