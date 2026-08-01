# QA Gate Baseline (Track B1) — run-1, 2026-07-10

Measured at run start (before any audit fix), on branch `claude/instruction-set-review-gsegfn`.

| Gate | Command | Result |
|---|---|---|
| Production build typecheck | `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` | **PASS** (exit 0) |
| Unit tests (api) | `npm test` (vitest run) | **PASS** — 9170 passed / 12 skipped / 43 todo (884 files) |
| Integration (RLS scoped) | `npm run test:rls` via `EXTERNAL_TEST_DB_URL` | **PASS** — 12 passed |
| HTTP load harness self-check | `npm run loadtest:http:selfcheck` | **PASS** — 13317 req, 2140 req/s, p95 11ms |
| Mixed 1000 harness self-check | `npm run loadtest:mixed:selfcheck` | **PASS** — WS+SSE+poll all green |

## Environment notes (load-bearing for the whole run)

- **Docker registry pulls are Forbidden (403)** in this sandbox — `pgvector/pgvector:pg16`
  and `testcontainers/ryuk:0.14.0` cannot be pulled, so the default testcontainers path
  (`npm run test:integration`, `TEST_DB=testcontainers`) **fails at global setup**.
- **Workaround (validated):** apt-installed `postgresql-16` + `postgresql-16-pgvector`, started
  the local `16/main` cluster, created superuser `serviceos` + db `serviceos_test`. The
  integration `global-setup.ts` honors **`EXTERNAL_TEST_DB_URL`** and skips the container:
  ```
  export EXTERNAL_TEST_DB_URL="postgres://serviceos:serviceos@localhost:5432/serviceos_test"
  export TESTCONTAINERS_RYUK_DISABLED=true
  npm run test:integration            # or test:rls, etc.
  ```
  This makes the full Docker-gated integration suite runnable here, so RLS/money/auth fixes
  can be proven with real DB tests (CLAUDE.md mandate) rather than mocked pools.
- **No provisioned staging environment** with N replicas + Redis + PgBouncer is reachable
  from this sandbox (the master prompt's "Decisions you own" flags this as the user's to
  supply). Per Guardrail 5 (never ask) + Guardrail 6 (load off prod), the run proves the
  **harness** + the **local per-instance curve**, and documents the true 1,000-concurrent
  certification as requiring the staging env — the honest "strong 80%, note what's cut".

## Codebase maturity (reframes the mission)

This is a heavily-hardened codebase, not a greenfield: **1,011 API test files, 121 integration
tests, 53 e2e specs**, a named `rls_cross_tenant` BYPASSRLS sweep role, existing
`rls-cross-tenant-sweep`, `payment-duplicate-race`, `late-fee-idempotency`, `ach-webhook`,
`tenant-isolation.leak` tests, a per-module coverage gate (`check-coverage.ts`), and a
dependency-free 1000-user load harness. Much of what the master prompt frames as "to build"
already exists. The audit therefore targets the **real remaining gaps and defects**, not
re-building existing infrastructure.
