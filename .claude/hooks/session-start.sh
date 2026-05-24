#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Ensures the remote session can run the full test suite — including the
# Postgres-testcontainer integration tests (packages/api test:integration),
# which need a running Docker daemon and the pgvector/pgvector:pg16 image.
#
# Steps (idempotent, non-interactive):
#   1. Install workspace dependencies (npm install).
#   2. Start the Docker daemon if it isn't already running.
#   3. Pre-pull the Postgres image so integration runs don't stall on a pull.
set -euo pipefail

# Only run in the remote (Claude Code on the web) environment. Locally the
# developer already has their own Docker/daemon and node_modules.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

echo "[session-start] Installing workspace dependencies…"
npm install

# Postgres image used by test/integration/global-setup.ts. Override-able so the
# hook tracks the test config if the image ever changes.
POSTGRES_IMAGE="${POSTGRES_IMAGE:-pgvector/pgvector:pg16}"

start_dockerd() {
  if docker info >/dev/null 2>&1; then
    echo "[session-start] Docker daemon already running."
    return 0
  fi

  if ! command -v dockerd >/dev/null 2>&1; then
    echo "[session-start] WARNING: dockerd not installed — integration tests will be unavailable."
    return 0
  fi

  echo "[session-start] Starting Docker daemon…"
  # Prefer sudo when we aren't root; fall back to a direct invocation.
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    sudo -n dockerd >/tmp/dockerd.log 2>&1 &
  else
    dockerd >/tmp/dockerd.log 2>&1 &
  fi

  # Wait up to ~30s for the daemon socket to come up.
  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      echo "[session-start] Docker daemon is up."
      return 0
    fi
    sleep 1
  done

  echo "[session-start] WARNING: Docker daemon did not start within 30s — integration tests may be unavailable."
  tail -n 20 /tmp/dockerd.log 2>/dev/null || true
  return 0
}

start_dockerd

if docker info >/dev/null 2>&1; then
  echo "[session-start] Pre-pulling ${POSTGRES_IMAGE}…"
  docker pull "${POSTGRES_IMAGE}" || \
    echo "[session-start] WARNING: failed to pull ${POSTGRES_IMAGE}; integration tests will pull on first run."
fi

echo "[session-start] Setup complete."
