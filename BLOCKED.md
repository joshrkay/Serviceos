# Launch-Readiness Pass — BLOCKED

## (RESOLVED) Integration + RLS suites — now passing against a real Postgres

**Status: RESOLVED.** Both `npm run test:rls` and `npm run test:integration` were
run **green** in this environment against a locally-provisioned Postgres 16.

### Original blocker
The integration suite (`vitest.integration.config.ts`) provisions Postgres via
**testcontainers** (`pgvector/pgvector:pg16` + `testcontainers/ryuk`). Image pulls
fail in this sandbox — the Docker registry CDN returns **403 Forbidden** on blob
downloads, and the session-start log warned of the same. So the container path
could not start here.

### Resolution
1. Installed Postgres 16 + `pgvector` locally (`postgresql-16`,
   `postgresql-16-pgvector` 0.6.0) and started the default cluster.
2. Added a backward-compatible escape hatch to
   `test/integration/global-setup.ts`: when `EXTERNAL_TEST_DB_URL` is set, it
   applies the migrations to that database and skips the testcontainer entirely
   (same migration path, superuser role, just a different host). When the var is
   unset, behavior is unchanged (testcontainer as before). This also lets CI run
   the suite against a service-container Postgres.
3. Ran both suites against the local DB:

```
EXTERNAL_TEST_DB_URL="postgresql://postgres:***@127.0.0.1:5432/serviceos_test" \
  npm run test:rls          # -> 8 passed (cross-tenant isolation verified)
EXTERNAL_TEST_DB_URL="postgresql://postgres:***@127.0.0.1:5432/serviceos_test" \
  npm run test:integration  # -> 40 files, 180 passed (all 146 migrations applied,
                            #    incl. migration 146; end-to-end paths green)
```

### Residual note
The **literal** `npm run test:rls` / `npm run test:integration` (no env var) still
require Docker-registry access to pull the testcontainer image, which this sandbox
blocks. On any normal CI runner (registry reachable) the default container path
works unchanged. The behavior and tenant-isolation guarantees are proven here via
the external-DB path; nothing in this pass weakens them.

**No features are BLOCKED.** All eight are SHIPPED (see PROGRESS.md / LAUNCH_REPORT.md).
