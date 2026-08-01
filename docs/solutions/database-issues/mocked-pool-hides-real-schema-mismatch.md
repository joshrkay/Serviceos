---
title: "Mocked pg Pool hides real schema mismatches — column/table/type errors ship green"
date: 2026-06-25
track: bug
problem_type: database-issues
module: packages/api/src
tags: ["postgres", "testing", "integration-tests", "schema", "mocked-pool", "rls"]
related: []
---

## Problem

A Pg repository or route can ship with SQL that references a **table, column,
or type that does not exist** (or is the wrong type), and every unit/route test
stays green — because those tests mock the `pg.Pool`/`PoolClient`, so the bad
query string is never executed against a real schema. The mismatch only
surfaces at runtime, in production, as a 500 or a silently-swallowed failure.

A 2026-06-25 beta-verification run (driving every workflow against the **real
API + real Postgres**) found **four** instances of this single pattern in one
sweep. CLAUDE.md already warns about it in the abstract ("the entity resolver
shipped with nonexistent column names because its Pool was mocked"); this entry
catalogs the concrete recurrences and the detection/prevention recipe.

## Symptoms

- A query that "must work" 500s for every tenant, or a background worker logs a
  Postgres error on every tick, while CI is fully green.
- Postgres error shapes: `invalid input syntax for type uuid: "..."` (string
  written to a UUID column), `relation "<table>" does not exist`,
  `column "<col>" does not exist`.
- Or **no error at all** — the failure is caught and swallowed, so an API
  returns success (`{queued:true}`, `200`) while the side effect (an SMS, a
  proposal execution) never happens.

### The four instances found in one run

| Where | Real schema mismatch | User-visible effect |
|---|---|---|
| `proposals/pg-proposal.ts` `claimForExecution` | `claimed_by` was `UUID`; the worker passes the string label `'execution-worker'` | `invalid input syntax for type uuid` every tick → **no approved proposal ever executed** |
| `routes/interactions.ts` | joined `locations.address_line1` — table is `service_locations`, column is `street1`; count `SELECT COUNT(*)` read as `rows[0].total` | `GET /api/interactions` **500 for every tenant** |
| `notifications/pg-delay-notice-state.ts` | INSERTs into `delay_notice_state`, a table **no migration ever created** | error swallowed by the route → running-late **SMS silently dropped**, idempotency guard dead |
| `telemetry/technician-location-authz.ts` | matched `clerk_user_id = $2` while callers naturally hold the `users.id` UUID | dispatcher/owner **403** when submitting a tech's location ping |

The first three share an exact tell: the repo's own unit test (or the route
test) constructed a fake Pool/`query` and asserted on the *shape* of the call,
never running the SQL.

## What Didn't Work

- **Trusting green CI.** The full unit suite (8000+ tests) passed with all four
  bugs present. Mocked-DB tests prove the code *calls* the query; they cannot
  prove the query is *valid against the schema*.
- **`tsc` / typecheck.** Types don't know that a SQL string column name doesn't
  exist, or that a TS `string` is being written to a SQL `uuid` column.
- **Applying the fix migration to a polluted dev DB.** Re-running the full
  migration set (`getMigrationSQL()`) against a database that already had test
  rows in odd states failed on `ATRewriteTable` / a `CHECK` constraint
  re-validation. Use a **fresh** database for the migration-from-scratch check.
- **Editing a column type on a live, running pool.** `ALTER COLUMN ... TYPE`
  while the app is up leaves per-connection cached query plans referencing the
  old type, so some pooled connections keep failing intermittently. A clean
  process restart (fresh pool) is needed to verify — or just run the
  integration test, which is the authoritative proof.

## Solution

Two halves: **fix the schema/query**, and **pin it with a real-Postgres
integration test** so it can never silently regress.

Fixes that landed (examples):

```diff
- // routes/interactions.ts
- l.address_line1 AS customer_address
- LEFT JOIN locations l ON ...
- SELECT COUNT(*) FROM voice_sessions ...   // read as rows[0].total
+ l.street1 AS customer_address
+ LEFT JOIN service_locations l ON ...
+ SELECT COUNT(*) AS total FROM voice_sessions ...
```

```sql
-- migration: claimed_by is a worker label, not a user id → align with executed_by/created_by (TEXT)
ALTER TABLE proposals ALTER COLUMN claimed_by TYPE TEXT USING claimed_by::text;
-- migration: create the table the wired repo depends on (+ RLS), matching the INSERT's columns
CREATE TABLE IF NOT EXISTS delay_notice_state ( idempotency_key TEXT PRIMARY KEY, ... );
```

The regression guard — `packages/api/test/integration/*.test.ts` — drives the
**real** repo/route against real Postgres, not a mock:

```ts
// pins the real column type: claimForExecution with the PRODUCTION worker label
const claimed = await repo.claimForExecution(proposalId, 'execution-worker'); // a string, not a uuid
expect(claimed!.status).toBe('executing');           // pre-fix: threw on the uuid column

// pins the real route + real columns via supertest, not a copied query
const res = await request(app).get('/api/interactions?limit=10');
expect(res.status).toBe(200);                         // pre-fix: 500
```

## Why This Works

The root cause is **proof-by-mock**: a mocked Pool returns whatever the test
says, so the SQL string is a dead literal the test never validates. Only a real
Postgres connection parses the SQL, resolves identifiers against the catalog,
and enforces column types — so only an integration test can fail when the
schema and the query disagree. The fixes make schema and query agree; the
integration tests make Postgres the arbiter so a future edit that re-introduces
the drift turns CI red instead of shipping.

## Prevention

- **Any DB-touching change gets a Docker-gated integration test in
  `packages/api/test/integration/` that pins the real columns** (CLAUDE.md
  rule). A mocked-DB test is necessary but never *sufficient* proof a query
  works. Prefer driving the real route via `supertest` over copying the query
  into the test (catches route-level drift too).
- **Run integration tests locally without Docker** by pointing the harness at a
  local Postgres — `global-setup.ts` honors `EXTERNAL_TEST_DB_URL`, applies
  migrations to it, and skips the testcontainer:

  ```bash
  # one-time: a FRESH db (migrations re-apply cleanly only on a clean db) with extensions
  su postgres -c "createdb serviceos_itest && psql -d serviceos_itest \
    -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;'"
  EXTERNAL_TEST_DB_URL='postgresql://postgres:postgres@127.0.0.1:5432/serviceos_itest' \
    npx vitest run --config vitest.integration.config.ts test/integration/<your-test>.test.ts
  ```

- **Catch type mismatches at write time:** when a repo writes a literal/string
  into a column, confirm the column's declared type (`\d <table>` or
  `information_schema.columns`). Worker/actor *labels* are `TEXT`
  (`created_by`, `executed_by`); only real entity references are `UUID`.
- **A migration that `ADD COLUMN ... IF NOT EXISTS` for a column "required by
  code"** is a smell that a repo shipped against schema that no migration
  created — grep the repo's INSERT/SELECT column list against the live schema.
- **Verify by running the app, not just the suite.** The whole class was found
  by driving real workflows over HTTP against real Postgres (see
  `docs/verification-runs/beta-verification-2026-06-25.md`), which is the only
  thing that exercises the SQL end-to-end.
