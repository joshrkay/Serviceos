#!/usr/bin/env bash
# Pre-flight checks for /dispatch-story.
# Exits 0 if every check passes, non-zero otherwise.
# Usage: bash .claude/skills/dispatch-story/preflight.sh <story-id>
#
# Required env (auto-detected from repo root): none.
# The script must run from the repo root.

set -u
set -o pipefail

STORY_ID="${1:-}"
if [[ -z "$STORY_ID" ]]; then
  echo "preflight: missing story ID (e.g. P0-019)" >&2
  exit 64
fi

if [[ ! "$STORY_ID" =~ ^P[0-9]+-[0-9]+$ ]]; then
  echo "preflight: story ID '$STORY_ID' does not match P<phase>-<num>" >&2
  exit 64
fi

PHASE="${STORY_ID#P}"
PHASE="${PHASE%%-*}"

ADDENDUM_PATH="docs/superpowers/contracts/p${PHASE}-dispatch-addendum.md"
STORY_PATH="docs/stories/phase-${PHASE}-gap-stories.md"

fail() {
  echo "preflight: FAIL — $1" >&2
  exit 1
}

ok() {
  echo "preflight: ok — $1"
}

# 1. Files exist.
[[ -f "$STORY_PATH" ]] || fail "story file not found: $STORY_PATH"
[[ -f "$ADDENDUM_PATH" ]] || fail "dispatch addendum not found: $ADDENDUM_PATH"
grep -q "^### ${STORY_ID} " "$STORY_PATH" || fail "story ${STORY_ID} not in $STORY_PATH"
grep -q "^## ${STORY_ID} " "$ADDENDUM_PATH" || fail "dispatch block for ${STORY_ID} not in $ADDENDUM_PATH"
ok "story + addendum located"

# 2. Working tree clean.
if [[ -n "$(git status --porcelain)" ]]; then
  fail "working tree is dirty (commit or stash before dispatching)"
fi
ok "working tree clean"

# 3. origin/main reachable.
git fetch --quiet origin main || fail "could not fetch origin/main"
ok "origin/main reachable"

# 4. tsc passes against packages/api production config (CLAUDE.md mandate).
if [[ -f packages/api/tsconfig.build.json ]]; then
  if ! (cd packages/api && npx --no-install tsc --project tsconfig.build.json --noEmit 2>&1 | tail -20); then
    fail "packages/api production tsc failed (fix before dispatching)"
  fi
  ok "packages/api production tsc passes"
fi

# 5. Dependency stories from the addendum's "Pre-flight:" line have merged on origin/main.
DEPS=$(awk -v id="$STORY_ID" '
  /^## / { in_block = ($0 ~ "^## " id " ") }
  in_block && /^\*\*Pre-flight:\*\*/ {
    sub(/^\*\*Pre-flight:\*\*/, "")
    print
    exit
  }
' "$ADDENDUM_PATH")

if [[ -n "$DEPS" ]]; then
  # Pre-read the full log into a variable so `grep -q`'s early-exit doesn't
  # trip pipefail+SIGPIPE on git log (which reports the dep as missing
  # even when it's present in the log).
  LOG=$(git log origin/main --oneline)
  for dep in $(echo "$DEPS" | grep -oE 'P[0-9]+-[0-9]+'); do
    if ! echo "$LOG" | grep -F -q "$dep"; then
      fail "dependency story ${dep} not yet merged on origin/main"
    fi
    ok "dependency ${dep} merged"
  done
fi

# 6. Migration number not yet taken.
MIG_NUM=$(awk -v id="$STORY_ID" '
  /^## / { in_block = ($0 ~ "^## " id " ") }
  in_block && /\*\*Migration number reserved:\*\*/ {
    match($0, /[0-9]{3}_/)
    if (RSTART > 0) {
      num = substr($0, RSTART, 3)
      print num
    }
    exit
  }
' "$ADDENDUM_PATH")

if [[ -n "$MIG_NUM" ]]; then
  if grep -q "'${MIG_NUM}_" packages/api/src/db/schema.ts 2>/dev/null; then
    fail "reserved migration number ${MIG_NUM} already used in db/schema.ts"
  fi
  ok "reserved migration ${MIG_NUM} is free"
fi

echo "preflight: PASS"
exit 0
