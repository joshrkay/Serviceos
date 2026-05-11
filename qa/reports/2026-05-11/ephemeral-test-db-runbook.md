# Ephemeral Test DB Runbook — e2e/journeys

**Date:** 2026-05-11
**Owner:** QA / Testing Infra
**Related:** `e2e/README.md`, `qa/reports/2026-05-11/clerk-testing-tokens-runbook.md`

## Strategy chosen and why

**Option D — testcontainers (Postgres-in-Docker), with a BYO-Postgres fallback.**

The production DB runs on **Railway** (Postgres), not Supabase, so the Supabase-branch path (Option A) does not apply. Of the remaining options, testcontainers wins because the integration-test layer (`packages/api/test/integration/global-setup.ts`) already uses the exact same `pgvector/pgvector:pg16` image and the exact same `getMigrationSQL()` migration runner — adopting it for journeys means zero new schema-drift risk, identical RLS behavior, and full per-run isolation. The script also accepts a pre-provisioned `DATABASE_URL`: in environments where Docker is unavailable (e.g. a hosted runner that doesn't expose the docker socket) ops can point it at a long-lived "serviceos_e2e_test" Postgres and the same setup/seed/teardown flow truncates between runs. Cold-start cost: roughly 10 seconds for the testcontainer; sub-second for the BYO mode.

## What the user must configure

For **local development** (testcontainer path) — nothing beyond having Docker running. The scripts handle everything.

For **CI**, configure these GitHub repository secrets (Settings → Secrets and variables → Actions → New repository secret). All names are exact:

1. **`E2E_DATABASE_URL`** *(optional)* — connection string for a pre-provisioned ephemeral Postgres. Leave unset to use the testcontainer (Docker is preinstalled on `ubuntu-latest`). If set, the database name **must** contain one of: `test`, `e2e`, `ephemeral`, `ci` (case-insensitive). Anything else is refused by the safety guard.
2. **`E2E_CLERK_PUBLISHABLE_KEY`** *(owned by Clerk agent)* — same secret used by the Clerk testing-tokens runbook. Required for the signup half.
3. **`E2E_CLERK_SECRET_KEY`** *(owned by Clerk agent)* — same.

No other secrets are required for this PR. The workflow file (`.github/workflows/e2e.yml`) sets `E2E_USE_TEST_DB=true` unconditionally; that turns the bootstrap on for every PR.

## How to run locally

Single command, from repo root:

```bash
E2E_USE_TEST_DB=true npx playwright test e2e/journeys/
```

Expected first-run output (abbreviated):

```
[e2e globalSetup] E2E_USE_TEST_DB=true — bootstrapping ephemeral DB…
[setup-test-db] starting pgvector/pgvector:pg16 testcontainer (~10s)…
[setup-test-db] container up: postgres://test:***@localhost:54321/serviceos_e2e_test
[setup-test-db] applying schema.ts MIGRATIONS…
[setup-test-db] applying loose .sql migrations…
[setup-test-db]   applied 072_add_executing_status.sql
[setup-test-db]   applied 073_add_execution_retry_count.sql
[setup-test-db] migrations complete
[setup-test-db] ready
[seed-journey] safety OK — Database name 'serviceos_e2e_test' matches a test-DB pattern
[seed-journey] wrote /…/e2e/fixtures/.journey-fixtures.env
[e2e globalSetup] loaded seeded tenant/customer/job/estimate/appointment IDs
…
Running 4 tests using 1 worker
  ✓ Journey 1 — seeded tenant can read its pre-existing estimate and job (3s)
  …
[e2e globalTeardown] E2E_USE_TEST_DB=true — tearing down ephemeral DB…
[teardown-test-db] stopping container abc123def456…
[teardown-test-db] container stopped + removed
```

Sub-commands if you want to drive the lifecycle yourself:

```bash
# Inspect what would happen without touching anything
npx tsx e2e/fixtures/setup-test-db.ts --dry-run
npx tsx e2e/fixtures/seed-journey-fixtures.ts --dry-run
npx tsx e2e/fixtures/teardown-test-db.ts --dry-run

# Real lifecycle
eval "$(npm run --silent e2e:db:setup)"   # exports DATABASE_URL
npm run e2e:db:seed                        # uses that DATABASE_URL
npm run e2e:db:teardown                    # stops container / truncates DB
```

## How CI uses it

`.github/workflows/e2e.yml` exports `E2E_USE_TEST_DB=true` for the `playwright` job. `e2e/global-setup.ts` then spawns `setup-test-db.ts` (which starts the testcontainer on the runner — Docker is preinstalled on `ubuntu-latest`), captures the printed `DATABASE_URL`, spawns `seed-journey-fixtures.ts`, and loads the resulting `.journey-fixtures.env` so every spec sees `process.env.E2E_TENANT_A_ID` and friends. `e2e/global-teardown.ts` stops the container after the run. The Clerk testing-tokens block in the same setup file is independent — it activates when `E2E_CLERK_*` secrets are present, no-ops otherwise.

## Known limitations + follow-up work

- **Single-worker only.** `playwright.config.ts` already sets `workers: 1`; if we ever raise this we'll need either per-worker DBs or a `BEGIN`/`ROLLBACK` per-test transaction wrapper.
- **Loose `.sql` migrations** (`packages/api/src/db/migrations/072_*.sql`, `073_*.sql`) are applied here even though the production `migrate.ts` doesn't apply them yet. That's a pre-existing inconsistency in the repo, not something this PR caused — file a follow-up to either fold those into the `MIGRATIONS` object or extend `migrate.ts` to read the dir.
- **Container cleanup on hard crash.** If Playwright is `kill -9`'d mid-run, the testcontainer stays alive. `npm run e2e:db:teardown` is safe to re-run and will reap from the state file; if the state file is also gone, `docker ps | grep pgvector` + `docker rm -f`.
- **Safety guard is heuristic.** It looks at the database name in the URL. A test DB named "main_test" would correctly pass; a real prod DB named "serviceos_production" is correctly rejected. The only ambiguous case is a DB with no name at all in the URL — that's rejected by default; set `E2E_DB_ALLOW_UNSAFE=1` to override.
- **No Supabase MCP branching.** The toolset was available and configured but the production DB is not Supabase, so this PR does not create any Supabase resources.
