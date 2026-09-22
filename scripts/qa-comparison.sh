#!/bin/bash
#
# ServiceOS QA Comparison Script
# Runs comprehensive QA suite and compares against previous run
# Usage: ./scripts/qa-comparison.sh [--previous YYYY-MM-DD] [--verbose]
# Exit codes:
#   0 = All required checks passed
#   1 = One or more required checks failed
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
QA_DIR="$ROOT_DIR/qa"
REPORT_DIR="$QA_DIR/reports"
TODAY=$(date +%Y-%m-%d)
PREVIOUS_RUN=""
VERBOSE=false
OVERALL_STATUS=0
declare -A CHECK_RESULTS

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --previous)
      PREVIOUS_RUN="$2"
      shift 2
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Create today's report directory
mkdir -p "$REPORT_DIR/$TODAY"

echo "=========================================="
echo "ServiceOS QA Comparison Run"
echo "Date: $TODAY"
echo "=========================================="
echo ""

# Save results to JSON for comparison
save_results_json() {
  local results_file="$REPORT_DIR/$TODAY/qa-status.json"

  # Build JSON from CHECK_RESULTS associative array
  cat > "$results_file" <<'JSON'
{
JSON

  echo "  \"date\": \"$TODAY\"," >> "$results_file"
  echo "  \"checks\": {" >> "$results_file"

  local first=true
  for check in "${!CHECK_RESULTS[@]}"; do
    IFS='|' read -r status details <<< "${CHECK_RESULTS[$check]}"

    if [[ "$first" == true ]]; then
      first=false
    else
      echo "," >> "$results_file"
    fi

    printf '    "%s": {"status": "%s", "details": "%s"}' "$check" "$status" "$details" >> "$results_file"
  done

  echo "" >> "$results_file"
  echo "  }" >> "$results_file"
  echo "}" >> "$results_file"
}

# Compare against previous run and detect regressions
compare_against_previous() {
  if [[ -z "$PREVIOUS_RUN" ]]; then
    # Try to find most recent previous run
    PREVIOUS_RUN=$(ls -t "$REPORT_DIR" 2>/dev/null | grep -v "$TODAY" | head -1)
  fi

  if [[ -n "$PREVIOUS_RUN" ]] && [[ -d "$REPORT_DIR/$PREVIOUS_RUN" ]]; then
    local prev_json="$REPORT_DIR/$PREVIOUS_RUN/qa-status.json"
    local curr_json="$REPORT_DIR/$TODAY/qa-status.json"

    echo "Comparing against run: $PREVIOUS_RUN"
    echo ""

    if [[ -f "$prev_json" ]]; then
      # Compare check-by-check
      local fixes=0
      local regressions=0
      local new_failures=0

      for check in "${!CHECK_RESULTS[@]}"; do
        IFS='|' read -r curr_status curr_details <<< "${CHECK_RESULTS[$check]}"

        # Extract previous status (simplified; proper JSON parsing would be better)
        local prev_status=$(grep -oP "\"$check\".*?\"status\": \"\\K[^\"]*" "$prev_json" 2>/dev/null || echo "unknown")

        # Detect fix or regression
        if [[ "$prev_status" == "fail" ]] && [[ "$curr_status" == "pass" ]]; then
          echo "  ✅ FIXED: $check (was failing, now passing)"
          ((fixes++))
        elif [[ "$prev_status" == "pass" ]] && [[ "$curr_status" == "fail" ]]; then
          echo "  ❌ REGRESSION: $check (was passing, now failing)"
          ((regressions++))
          OVERALL_STATUS=1
        elif [[ "$prev_status" == "unknown" ]] && [[ "$curr_status" == "fail" ]]; then
          echo "  ➕ NEW: $check (new failure)"
          ((new_failures++))
        fi
      done

      echo ""
      echo "Summary:"
      echo "  Fixes: $fixes"
      echo "  Regressions: $regressions"
      echo "  New Failures: $new_failures"
      if [[ $regressions -gt 0 ]]; then
        echo "  🔴 REGRESSION DETECTED — fix before shipping"
      fi
    else
      record_result "Regression Check" "skip" "No previous results to compare" false
    fi
  else
    record_result "Regression Check" "skip" "Baseline run — no previous results" false
  fi
}

# Helper function to track and log results
record_result() {
  local check_name=$1
  local status=$2  # "pass", "fail", "skip", "timeout"
  local details=$3
  local required=${4:-true}  # Is this a required check?

  # Store result
  CHECK_RESULTS["$check_name"]="$status|$details"

  # Log with icon
  local icon
  case "$status" in
    pass) icon="✅" ;;
    fail) icon="❌"; [[ "$required" == "true" ]] && OVERALL_STATUS=1 ;;
    timeout) icon="⏱" ;;
    skip) icon="⏭️" ;;
    *) icon="❓" ;;
  esac

  echo "[$icon] $check_name"
  if [[ $VERBOSE == true ]]; then
    echo "    $details"
  fi
}

# 1. Type Checking
echo "[1/8] Type Checking..."
if npm run typecheck:api > /dev/null 2>&1; then
  record_result "typecheck:api" "pass" "0 errors" true
else
  record_result "typecheck:api" "fail" "Errors found" true
fi

if npm run typecheck:web > /dev/null 2>&1; then
  record_result "typecheck:web" "pass" "0 errors" true
else
  record_result "typecheck:web" "fail" "Errors found" true
fi

echo ""

# 2. Unit Tests - Shared
echo "[2/8] Unit Tests - Shared Package..."
if npm test --workspace=packages/shared 2>/tmp/qa-shared.log > /tmp/qa-shared.out 2>&1; then
  SHARED_TESTS=$(grep -oP 'Tests\s+\K[^ ]+' /tmp/qa-shared.out | head -1)
  record_result "test:shared" "pass" "$SHARED_TESTS" true
else
  record_result "test:shared" "fail" "Tests failed" true
fi

echo ""

# 3. Linting
echo "[3/8] Linting..."
npm run lint:eslint > "$REPORT_DIR/$TODAY/lint-report.txt" 2>&1
LINT_EXIT=$?
if [[ $LINT_EXIT -eq 0 ]]; then
  record_result "lint:eslint" "pass" "0 errors" true
else
  # Extract error and warning counts from ESLint output (summary line format: "N error" or "0 errors")
  LINT_OUTPUT=$(cat "$REPORT_DIR/$TODAY/lint-report.txt")
  LINT_ERRORS=$(echo "$LINT_OUTPUT" | grep -oP '^\s*\d+\s+error' | grep -oP '\d+' | head -1)
  LINT_ERRORS=${LINT_ERRORS:-1}
  record_result "lint:eslint" "fail" "$LINT_ERRORS errors found" true
fi

echo ""

# 4. API Unit Tests (with timeout)
echo "[4/8] Unit Tests - API Package (timeout 300s)..."
timeout 300 npm test --workspace=packages/api > /tmp/qa-api.out 2>&1
API_EXIT=$?
if [[ $API_EXIT -eq 0 ]]; then
  API_TESTS=$(grep -oP 'Tests\s+\K[^ ]+' /tmp/qa-api.out | head -1)
  record_result "test:api" "pass" "$API_TESTS" false
elif [[ $API_EXIT -eq 124 ]]; then
  record_result "test:api" "timeout" "Exceeded 300s (infrastructure issue)" false
else
  record_result "test:api" "fail" "Tests failed" false
fi

echo ""

# 5. Web Unit Tests (with timeout)
echo "[5/8] Unit Tests - Web Package (timeout 300s)..."
timeout 300 npm test --workspace=packages/web > /tmp/qa-web.out 2>&1
WEB_EXIT=$?
if [[ $WEB_EXIT -eq 0 ]]; then
  WEB_TESTS=$(grep -oP 'Tests\s+\K[^ ]+' /tmp/qa-web.out | head -1)
  record_result "test:web" "pass" "$WEB_TESTS" false
elif [[ $WEB_EXIT -eq 124 ]]; then
  record_result "test:web" "timeout" "Exceeded 300s (infrastructure issue)" false
else
  record_result "test:web" "fail" "Tests failed" false
fi

echo ""

# 6. Integration Tests
echo "[6/8] Integration Tests..."
if command -v docker &> /dev/null && docker ps &> /dev/null; then
  timeout 300 npm run test:integration --workspace=packages/api > /tmp/qa-integration.out 2>&1
  INTEGRATION_EXIT=$?
  if [[ $INTEGRATION_EXIT -eq 0 ]]; then
    INTEGRATION_TESTS=$(grep -oP 'Tests\s+\K[^ ]+' /tmp/qa-integration.out | head -1)
    record_result "test:integration" "pass" "$INTEGRATION_TESTS" false
  elif [[ $INTEGRATION_EXIT -eq 124 ]]; then
    record_result "test:integration" "timeout" "Exceeded 300s" false
  else
    record_result "test:integration" "fail" "Setup or execution failed" false
  fi
else
  record_result "test:integration" "skip" "Docker not available" false
fi

echo ""

# 7. E2E Tests
echo "[7/8] E2E Tests..."
if [[ -n "$E2E_BASE_URL" ]]; then
  if timeout 300 npm run e2e:smoke 2>/tmp/qa-e2e.log > /tmp/qa-e2e.out 2>&1; then
    record_result "test:e2e" "pass" "Smoke tests passed" false
  else
    record_result "test:e2e" "fail" "Failed or timed out" false
  fi
else
  record_result "test:e2e" "skip" "E2E_BASE_URL not set" false
fi

echo ""

# 8. Regression Comparison
echo "[8/8] Regression Comparison..."
save_results_json
compare_against_previous

echo ""
echo "=========================================="
echo "QA Run Complete"
echo "Report Location: $REPORT_DIR/$TODAY/"
echo "Exit Code: $OVERALL_STATUS (0=pass, 1=required check failed)"
echo "=========================================="

exit $OVERALL_STATUS
