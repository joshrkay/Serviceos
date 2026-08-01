#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Ensures the remote session can run the full test suite — including the
# Postgres-testcontainer integration tests (packages/api test:integration),
# which need a running Docker daemon and the pgvector/pgvector:pg16 image.
#
# Steps (idempotent, non-interactive):
#   1. Install workspace dependencies (npm install).
#   2. Start the Docker daemon if it isn't already running (clearing stale
#      pid files left behind by a container pause/resume).
#   3. Pre-pull the Postgres + testcontainers-reaper images so integration
#      runs don't stall on a pull — falling back to mirror.gcr.io when the
#      egress policy blocks Docker Hub's blob CDN.
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

# Docker Hub pull-through cache reachable when the org egress policy blocks
# Docker Hub's blob CDN (production.cloudfront.docker.com) — see
# docs/solutions/test-failures/docker-hub-cdn-blocked-in-remote-sessions.md.
DOCKERHUB_MIRROR="${DOCKERHUB_MIRROR:-mirror.gcr.io}"

# Root needed for dockerd and for clearing its stale pid files.
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo -n"
fi

start_dockerd() {
  if docker info >/dev/null 2>&1; then
    echo "[session-start] Docker daemon already running."
    return 0
  fi

  if ! command -v dockerd >/dev/null 2>&1; then
    echo "[session-start] WARNING: dockerd not installed — integration tests will be unavailable."
    return 0
  fi

  # After a container pause/resume the previous daemon is gone but its pid
  # files survive, and the recorded PIDs may now belong to unrelated
  # processes — dockerd then refuses to start ("process with PID N is still
  # running" / "timeout waiting for containerd"). The daemon is provably not
  # up (docker info failed above), so clear the stale state.
  if ! pgrep -x dockerd >/dev/null 2>&1; then
    ${SUDO} rm -f /var/run/docker.pid /var/run/docker/containerd/containerd.pid 2>/dev/null || true
  fi

  echo "[session-start] Starting Docker daemon…"
  ${SUDO} dockerd >/tmp/dockerd.log 2>&1 &

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

# Pull an image, falling back to the Docker Hub mirror when the canonical pull
# fails (the remote egress policy blocks Docker Hub's blob CDN but allows
# mirror.gcr.io). The mirror image is retagged to its canonical name so
# testcontainers' default pull policy finds it locally and never pulls.
pull_with_mirror_fallback() {
  local image="$1"
  if docker image inspect "${image}" >/dev/null 2>&1; then
    echo "[session-start] ${image} already present."
    return 0
  fi
  if docker pull "${image}"; then
    return 0
  fi
  echo "[session-start] Canonical pull of ${image} failed — trying ${DOCKERHUB_MIRROR}/${image}…"
  if docker pull "${DOCKERHUB_MIRROR}/${image}" && \
     docker tag "${DOCKERHUB_MIRROR}/${image}" "${image}"; then
    echo "[session-start] Pulled ${image} via ${DOCKERHUB_MIRROR}."
    return 0
  fi
  return 1
}

if docker info >/dev/null 2>&1; then
  echo "[session-start] Pre-pulling ${POSTGRES_IMAGE}…"
  pull_with_mirror_fallback "${POSTGRES_IMAGE}" || \
    echo "[session-start] WARNING: failed to pull ${POSTGRES_IMAGE}; integration tests will pull on first run."

  # Testcontainers also needs its reaper (ryuk) image at test runtime; its tag
  # is pinned inside the installed library, so derive it rather than hardcode.
  RYUK_IMAGE="$(grep -rhoE 'testcontainers/ryuk:[0-9.]+' node_modules/testcontainers/build/ 2>/dev/null | sort -u | head -1 || true)"
  if [ -n "${RYUK_IMAGE}" ]; then
    echo "[session-start] Pre-pulling ${RYUK_IMAGE}…"
    pull_with_mirror_fallback "${RYUK_IMAGE}" || \
      echo "[session-start] WARNING: failed to pull ${RYUK_IMAGE}; integration tests will pull on first run."
  fi
fi

echo "[session-start] Setup complete."
