#!/usr/bin/env bash
# Consolidate the duplicate local clone Serviceos-1 into the canonical monorepo.
# Canonical working tree: this repo (Serviceos/Serviceos). Sibling: ../Serviceos-1
#
# Prerequisites (already done once on this machine):
#   git remote add serviceos1 ../Serviceos-1
#   git fetch serviceos1
#
# Usage:
#   cd Serviceos/Serviceos
#   ./tools/consolidate-sibling-clone.sh merge    # merge rescued e2e/training work (may conflict)
#   ./tools/consolidate-sibling-clone.sh status   # show remotes and rescue ref
#   ./tools/consolidate-sibling-clone.sh remove-serviceos1   # AFTER merge+push: delete sibling folder (destructive)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANON="$ROOT"
SIBLING="$(cd "$CANON/.." && pwd)/Serviceos-1"
RESCUE_REF="serviceos1/wip/rescue-serviceos-1-local"

cd "$CANON"

cmd="${1:-status}"

case "$cmd" in
  status)
    echo "Canonical repo: $CANON"
    echo "Sibling clone (duplicate): $SIBLING"
    echo ""
    git remote -v | grep -E '^serviceos1' || echo "Remote serviceos1 not configured. Run: git remote add serviceos1 ../Serviceos-1 && git fetch serviceos1"
    echo ""
    if git rev-parse "$RESCUE_REF" >/dev/null 2>&1; then
      echo "Rescue branch available: $RESCUE_REF -> $(git rev-parse --short "$RESCUE_REF")"
    else
      echo "Rescue ref missing. Fetch: git fetch serviceos1"
    fi
    ;;
  merge)
    if ! git rev-parse "$RESCUE_REF" >/dev/null 2>&1; then
      echo "Fetch first: git remote add serviceos1 ../Serviceos-1 2>/dev/null; git fetch serviceos1" >&2
      exit 1
    fi
    echo "Merging $RESCUE_REF into $(git branch --show-current). Resolve conflicts, then commit."
    git merge "$RESCUE_REF" --no-edit || {
      echo "Merge stopped with conflicts. Fix files, then: git add -A && git commit"
      exit 1
    }
    ;;
  remove-serviceos1)
    if [[ ! -d "$SIBLING" ]]; then
      echo "Sibling path not found: $SIBLING"
      exit 1
    fi
    echo "This will permanently delete: $SIBLING"
    echo "Ensure rescue work is merged and pushed. Type YES to delete:"
    read -r confirm
    if [[ "$confirm" != "YES" ]]; then
      echo "Aborted."
      exit 1
    fi
    rm -rf "$SIBLING"
    git remote remove serviceos1 2>/dev/null || true
    echo "Removed sibling clone and serviceos1 remote (if present)."
    ;;
  *)
    echo "Usage: $0 {status|merge|remove-serviceos1}"
    exit 1
    ;;
esac
