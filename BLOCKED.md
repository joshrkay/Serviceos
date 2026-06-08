# Launch-Readiness Pass — BLOCKED

## Integration + RLS suites (`pnpm test:rls`, `pnpm test:integration`) — BLOCKED BY ENVIRONMENT

**Status:** Could not execute in this sandbox. **Not** a code or isolation failure.

**Diagnosis.** The integration suite (`vitest.integration.config.ts`) provisions a
real Postgres via **testcontainers** (`pgvector/pgvector:pg16`) plus the
testcontainers reaper (`testcontainers/ryuk:0.14.0`). Both image pulls fail in
this environment:

```
Error during global setup:
  (HTTP code 404) no such container - No such image: testcontainers/ryuk:0.14.0
docker pull pgvector/pgvector:pg16  -> 403 Forbidden (registry CDN blob)
docker pull testcontainers/ryuk:0.14.0 -> 403 Forbidden (registry CDN blob)
```

The session-start log warned of the same: *"failed to pull pgvector/pgvector:pg16;
integration tests will pull on first run."* The container runtime is up, but the
network policy blocks Docker registry layer downloads (403 on the CDN blob URLs),
so no Postgres-backed test can start here.

**Why this is not an RLS/security failure.**
- The work in this pass added **no new tenant-scoped table** — only one additive
  column (`tenant_settings.bill_labor_from_time_entries`) on a table that already
  carries `ENABLE`+`FORCE` RLS. The RLS surface is unchanged.
- The **static** RLS guards run without a DB and **pass**:
  - `test/db/schema.test.ts` (17 tests) — pins that every `tenant_id` table has
    `FORCE ROW LEVEL SECURITY` + a `tenant_isolation_<table>` policy, and that the
    documented exemption set has not grown.
  - `test/db/migration-immutability.test.ts` — migration 146 locked into the
    immutability snapshot.
- Migration 146 mirrors the already-deployed migration 138 verbatim
  (`ALTER TABLE … ADD COLUMN IF NOT EXISTS … BOOLEAN NOT NULL DEFAULT false`).

**To clear (on a runner with Docker registry access):**
```
npm run test:rls          # RLS tenant-isolation integration test
npm run test:integration  # full end-to-end suite incl. migration 146 apply
```
These are expected to pass: the global-setup applies all 146 migrations in one
transaction, and the RLS isolation test runs as an unprivileged `rls_app_runtime`
role. Nothing in this pass changes that path.
