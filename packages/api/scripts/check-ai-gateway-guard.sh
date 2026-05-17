#!/usr/bin/env bash
# P2-027 Gap 3 — AI gateway guard
#
# Fails the build if any TypeScript/JavaScript source file outside the
# gateway/providers tree calls OpenAI directly instead of going through
# LLMGateway.complete().
#
# Usage:
#   ./scripts/check-ai-gateway-guard.sh [extra-dir...]
#
#   When extra-dir is supplied the guard also searches those directories.
#   This is used by tests to plant an offending file in a temp dir and
#   verify the guard catches it.
#
# Exit codes:
#   0 — no direct provider calls found
#   1 — one or more direct provider calls found (build should fail)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SCRIPT_DIR}/../src"

# Directories that ARE allowed to use OpenAI SDK directly
GATEWAY_DIR="${SRC_DIR}/ai/gateway"
PROVIDERS_DIR="${SRC_DIR}/ai/providers"

OFFENDERS=()

# Fixed-string patterns that indicate a direct provider call
FIXED_PATTERNS=(
  'new OpenAI('
)

# Extended-regex patterns that indicate a direct provider call
REGEX_PATTERNS=(
  'client\.chat\.completions\.create'
)

# Collect search paths: always search src/, plus any extra dirs passed as args
SEARCH_PATHS=("${SRC_DIR}")
for extra in "$@"; do
  SEARCH_PATHS+=("${extra}")
done

for search_path in "${SEARCH_PATHS[@]}"; do
  # Find all TS/JS files, excluding the gateway and providers directories
  while IFS= read -r -d '' file; do
    # Skip files inside the allowed gateway/providers trees
    case "${file}" in
      "${GATEWAY_DIR}/"*|"${PROVIDERS_DIR}/"*)
        continue
        ;;
    esac

    for pattern in "${FIXED_PATTERNS[@]}"; do
      if grep -qF "${pattern}" "${file}" 2>/dev/null; then
        rel="${file#${SCRIPT_DIR}/../}"
        OFFENDERS+=("${rel}: matches fixed pattern '${pattern}'")
      fi
    done

    for pattern in "${REGEX_PATTERNS[@]}"; do
      if grep -qE "${pattern}" "${file}" 2>/dev/null; then
        rel="${file#${SCRIPT_DIR}/../}"
        OFFENDERS+=("${rel}: matches pattern '${pattern}'")
      fi
    done
  done < <(find "${search_path}" \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) -print0 2>/dev/null)
done

if [ ${#OFFENDERS[@]} -gt 0 ]; then
  echo "[ai-gateway-guard] FAIL: Direct OpenAI/provider calls found outside gateway/providers tree:" >&2
  for item in "${OFFENDERS[@]}"; do
    echo "  - ${item}" >&2
  done
  echo "" >&2
  echo "Route all LLM calls through LLMGateway.complete() in packages/api/src/ai/gateway/." >&2
  exit 1
fi

echo "[ai-gateway-guard] OK: No direct provider calls outside gateway/providers tree."
exit 0
