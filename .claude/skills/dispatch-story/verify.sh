#!/usr/bin/env bash
# Verification gate runner for /dispatch-story.
# Extracts the verification gate command from the dispatch addendum
# and runs it. Exits with the gate's exit code.
#
# Usage: bash .claude/skills/dispatch-story/verify.sh <story-id> [<worktree-path>]
# If worktree-path is omitted, runs in the current directory.

set -u
set -o pipefail

STORY_ID="${1:-}"
WORKTREE="${2:-.}"

if [[ -z "$STORY_ID" ]]; then
  echo "verify: missing story ID" >&2
  exit 64
fi

PHASE="${STORY_ID#P}"
PHASE="${PHASE%%-*}"
ADDENDUM_PATH="docs/superpowers/contracts/p${PHASE}-dispatch-addendum.md"

if [[ ! -f "$ADDENDUM_PATH" ]]; then
  echo "verify: addendum not found: $ADDENDUM_PATH" >&2
  exit 1
fi

# Extract the first ```bash ... ``` block under the "Verification gate" heading
# inside the story's `## <id>` section.
GATE_CMD=$(awk -v id="$STORY_ID" '
  /^## / { in_block = ($0 ~ "^## " id " "); next }
  in_block && /\*\*Verification gate/ { in_gate = 1; next }
  in_gate && /^```bash$/ { in_code = 1; next }
  in_gate && in_code && /^```/ { exit }
  in_gate && in_code { print }
' "$ADDENDUM_PATH")

if [[ -z "$GATE_CMD" ]]; then
  echo "verify: no verification gate command found for ${STORY_ID}" >&2
  exit 1
fi

echo "verify: running gate for ${STORY_ID} in ${WORKTREE}"
echo "----- gate command -----"
echo "$GATE_CMD"
echo "------------------------"

cd "$WORKTREE"
bash -c "$GATE_CMD"
RC=$?

if [[ $RC -eq 0 ]]; then
  echo "verify: PASS (${STORY_ID})"
else
  echo "verify: FAIL (${STORY_ID}, exit ${RC})" >&2
fi
exit $RC
