---
module: test-integration
tags: [docker, testcontainers, egress-policy, claude-code-remote, mirror.gcr.io]
problem_type: environment-failure
---

# Docker Hub pulls fail in Claude Code remote sessions (CDN blocked by egress policy)

## Symptom

In a Claude Code on the web session, `npm run test:integration` (packages/api)
cannot start its Postgres testcontainer:

- `docker pull pgvector/pgvector:pg16` prints `pg16: Pulling from
  pgvector/pgvector` and then fails on every layer download.
- Testcontainers dies earlier with `(HTTP code 404) no such container - No
  such image: testcontainers/ryuk:0.14.0` — the reaper image pull failed the
  same way.
- A direct pull reproduces a `403 Forbidden` (CloudFront-fronted).

A second, unrelated-looking symptom after a container pause/resume: the
SessionStart hook reports `Docker daemon did not start within 30s`, with
dockerd logging `process with PID N is still running` or
`timeout waiting for containerd to start`.

## Diagnosis

Run `curl -sS "$HTTPS_PROXY/__agentproxy/status"`. The `recentRelayFailures`
list names the blocked host:

```
"kind": "connect_rejected",
"detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
"host": "production.cloudfront.docker.com:443"
```

The org egress policy allows Docker Hub's **registry API**
(`registry-1.docker.io`, `auth.docker.io` — so manifests fetch fine) but
blocks Docker Hub's **blob CDN** (`production.cloudfront.docker.com` — so
every layer download 403s). `quay.io` is also blocked. Allowed alternatives
(verified reachable through the proxy): `mirror.gcr.io` (Google's Docker Hub
pull-through cache — serves the same images under the same paths), `ghcr.io`,
`public.ecr.aws`.

The pause/resume daemon failure is separate: the old daemon's
`/var/run/docker.pid` and `/var/run/docker/containerd/containerd.pid` survive
the resume, and the recorded PIDs now belong to unrelated processes, so
dockerd refuses to start.

## Fix

1. **Root cause (environment owner action):** add
   `production.cloudfront.docker.com` to the allowed domains in the Claude
   Code environment's network policy (claude.ai/code → environment settings →
   network access). One host — the registry API side is already allowed.
2. **In-repo fallback (shipped):** `.claude/hooks/session-start.sh`
   - clears stale docker/containerd pid files when `docker info` fails and no
     dockerd process exists, then starts the daemon;
   - pre-pulls `pgvector/pgvector:pg16` AND the testcontainers reaper image
     (tag derived from `node_modules/testcontainers/build/`, never
     hardcoded), falling back to `mirror.gcr.io/<image>` + `docker tag` back
     to the canonical name when the canonical pull fails. Testcontainers'
     default pull policy uses a locally present image, so the retag makes the
     test suite work unmodified.

Manual one-off equivalent inside a session:

```bash
sudo rm -f /var/run/docker.pid /var/run/docker/containerd/containerd.pid
sudo dockerd &            # wait for `docker info` to succeed
docker pull mirror.gcr.io/pgvector/pgvector:pg16
docker tag  mirror.gcr.io/pgvector/pgvector:pg16 pgvector/pgvector:pg16
docker pull mirror.gcr.io/testcontainers/ryuk:0.14.0
docker tag  mirror.gcr.io/testcontainers/ryuk:0.14.0 testcontainers/ryuk:0.14.0
cd packages/api && npm run test:integration
```

## Notes

- Do NOT disable TLS verification or unset `HTTPS_PROXY`; per
  `/root/.ccr/README.md`, 403 policy denials should be reported (fix 1), and
  the mirror fallback only uses hosts the policy already allows.
- `EXTERNAL_TEST_DB_URL` (test/integration/global-setup.ts) remains the
  container-free escape hatch when Docker is entirely unavailable.
