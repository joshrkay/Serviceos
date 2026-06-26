---
title: "Shared-DB integration test: assert the migration's effect, not ambient catalog state"
date: 2026-06-26
track: bug
problem_type: test-failures
module: packages/api/test/integration
tags: ["postgres", "integration-tests", "rls", "grants", "test-isolation", "vitest", "singleFork", "ci"]
related:
  - docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md
  - docs/solutions/architecture-patterns/rls-exempt-tables-read-before-tenant-context.md
---

## Problem
A new integration test asserted the *ambient* state of the shared test database
(`rls_app_runtime` holds no grant on the RLS-exempt tables, as left by migration
219). It passed when the file was run alone but failed in the full CI suite,
because sibling suites mutate that shared state.

## Symptoms
```
FAIL test/integration/rls-runtime-audit.test.ts > deny-list (migration 219)
AssertionError: rls_app_runtime must hold NO grant on the tenant_id-without-RLS
tables, found: [{"table_name":"platform_deprovision_log","privilege_type":"DELETE"},
... oauth_states:SELECT ...]: expected [ …(8) ] to deeply equal []
```
Green locally (ran only 2 integration files); red on CI (ran all 102).

## What Didn't Work
- Running the file in isolation (`vitest run <file>`) — passed, hiding the
  pollution. This is the same isolation trap as flaky component tests.
- Suspecting migration 219 itself — the migration is correct; the *test's*
  assumption about DB state was wrong.

## Solution
The integration suite runs in a **single fork** (`vitest.integration.config.ts`:
`pool: 'forks', singleFork: true`) sharing **one** database. ~10 sibling suites
(`reports`, `public-intake`, `rls-tenant-isolation`, `dropped-call-worker`, …)
deliberately run, in their setup:
```ts
await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_app_runtime`);
```
so they can exercise RLS policies under that role. That re-adds the grants
migration 219 revoked. Whichever granting sibling runs first leaves the exempt
tables granted — so an ambient-state assertion is order-dependent.

Fix: assert the migration's **effect** instead of ambient state — reproduce the
dirty grants, replay the **real** migration SQL (imported, not copied → no
drift), then prove its discovery+revoke clears the exempt tables:
```ts
import { MIGRATIONS } from '../../src/db/schema';
// ...
const pool = await getSharedTestDb();
await pool.query(
  `GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_states, platform_deprovision_log TO rls_app_runtime`,
);
await pool.query(MIGRATIONS['219_rls_app_runtime_revoke_exempt']); // the real migration
const res = await pool.query(
  `SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE grantee = 'rls_app_runtime' AND table_schema = 'public' AND table_name = ANY($1)`,
  [EXEMPT_TABLES],
);
expect(res.rows.map(r => `${r.table_name}:${r.privilege_type}`)).toEqual([]);
```

## Why This Works
The test no longer depends on what siblings did to the shared grant state — it
*creates* the polluted state itself, then verifies the migration cleans it. It
still fails if migration 219 ever stops catching an RLS-less `tenant_id` table
(the real invariant). Importing the migration from `MIGRATIONS` (the same map the
immutability test uses) means the test runs the exact shipped SQL, with no
copy/paste drift.

## Prevention
- In a shared, serial integration DB, do **not** assert ambient cluster/catalog
  state (roles, grants, GUCs, sequences) that any other suite might mutate.
  Either (a) drive the unit-under-test to *establish* the state it asserts, or
  (b) assert against a resource the test owns (a tenant/table it created).
- To verify a migration's effect, replay the real migration value from
  `MIGRATIONS` rather than re-querying post-boot catalog state or copying the SQL
  into the test.
- Reach for the **full** `npm run test:integration` before claiming a DB-touching
  change is green — a targeted single-file run cannot surface cross-suite shared
  state pollution (this is the same shortcut that hid an `oauth_states` RLS bug
  earlier on this branch).
