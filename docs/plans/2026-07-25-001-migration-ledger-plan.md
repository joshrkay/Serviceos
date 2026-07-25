# Migration ledger — Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`)
> syntax. Do not start Task 4 until Task 3's integration test is green against a
> real Postgres.

**Goal:** Record which migrations have been applied, so a deploy runs only what
is pending, `getMigrationSQL()` stops being the only source of truth about
schema state, and non-idempotent migrations fail on the deploy that introduces
them rather than the one after.

**Architecture:** Add a `schema_migrations` ledger table. Baseline it on first
contact by marking the entire existing corpus as applied — existing databases
already have that schema, so replaying it is wasted work, and *not* marking it
would make the first ledgered deploy attempt 265 migrations against a populated
database. Keep the advisory lock, the `25s` statement timeout, and the critical
constraint verification exactly as they are.

**Tech Stack:** TypeScript, node-postgres, Vitest, Testcontainers (pgvector/pg16)

---

## Severity correction — read before prioritising this

An earlier revision of the quality baseline called this "the clearest scaling
cliff in the system" and said the corpus replayed "on every boot". **Both
claims were wrong**, and this plan exists at a much lower priority than that
framing implied. Measured facts:

| Claim | Reality |
|---|---|
| "Replays on every boot" | Runs **once per deploy**. `railway.toml:13` runs `migrate.js` as `preDeployCommand`; `src/index.ts` has no migration reference. `railway.worker.toml:11` confirms the worker never migrates. |
| "25s timeout is a scaling cliff" | Replay takes **210 ms** — 0.8% of the budget. **24.8 s** headroom. |
| "Corpus growth will hit the cap" | At the measured 0.8 ms/migration it would take roughly **31,500** migrations. There is no cliff at 265. |
| Failure blast radius | Deploy aborts, old version keeps serving. Not a fleet crash-loop. |

Measured on `pgvector/pgvector:pg16` via testcontainers against the real
`getMigrationSQL()` output (265 migrations, 266,594 chars):

| Pass | Wall clock |
|---|---|
| cold, empty database | 2,631 ms |
| replay against migrated DB | 210 ms |
| replay again | 187 ms |

**Do this work for the reasons below, not for speed.** If it competes with the
`app.ts` decomposition (D-022) for a slot, `app.ts` wins.

## What is actually worth fixing

1. **Idempotency rests on two regexes.** `getMigrationSQL()` makes DDL
   re-runnable by string-substituting `CREATE POLICY …` and
   `ALTER TABLE … ADD CONSTRAINT …` into drop-then-create pairs. A migration
   written in a shape those regexes do not match is silently non-idempotent,
   and it fails on the **next** deploy — not the one that introduced it. A
   ledger makes each migration run exactly once, which removes the dependence
   entirely, and Task 3's replay test catches the rest.
2. **Nothing records what ran when.** `scripts/prod-schema-probe.sql:3` states
   outright that "there is no schema_migrations version table on the deploy
   path", so diagnosing a schema question means reading code and inferring.
3. **A handful of migrations scan on every deploy.** 12 `UPDATE` backfills,
   2 `DELETE`, 2 `INSERT`. All are self-limiting — guarded by predicates that
   match nothing after the first run — so they *write* nothing on replay, but
   they still scan to discover that. `198` runs a `row_number()` window over
   open customer conversations; `214` scans `jobs` for NULL
   `review_request_sent_at`. These are the only costs here that grow with
   production data rather than with migration count.

Explicitly checked and **not** problems — do not "fix" these:

- The 50 `ADD COLUMN … NOT NULL DEFAULT` statements are metadata-only on
  PostgreSQL 11+ (production is PG16). No table rewrite.
- `253_users_tenant_clerk_unique` uses a real `TEMP` table
  (`_user_dup_victims`) and drops it.
- The advisory lock (`migrate.ts:43-60`) is correct and must be preserved.

## Global Constraints

- Never auto-execute proposals; AI remains advisory.
- Money stays integer cents; tenant isolation absolute.
- Preserve `withMigrationAdvisoryLock` — concurrent deploys must still
  serialize.
- Preserve `verifyCriticalConstraints` and the
  `ALLOW_MISSING_CRITICAL_CONSTRAINTS` escape hatch.
- Preserve `lock_timeout = '5s'` and `statement_timeout = '25s'` for the apply
  path.
- Verify the production build with
  `npx tsc --project tsconfig.build.json --noEmit`.
- A DB-touching change requires a Docker-gated integration test under
  `packages/api/test/integration/` (CLAUDE.md).

## The ordering trap — read before writing any code

`MIGRATIONS` is a plain object in `packages/api/src/db/schema.ts:25`. Its keys
look sortable but **are not**:

| Property | Value |
|---|---|
| Keys | 265 |
| Distinct numeric prefixes | 259 |
| **Duplicate prefixes** | **6** — `070`, `092`, `125`, `173`, `177`, `221` each appear twice |
| Gaps | 3 — `055`, `181`, `235` |
| Max prefix | 262 |
| **Insertion order == numeric sort order?** | **No** |

Consequences that a naive implementation gets wrong:

- The ledger's primary key must be the **full key string**
  (`070_tenant_integrations`), never the numeric prefix — six collisions
  otherwise.
- Apply order must be `Object.keys(MIGRATIONS)` (V8 preserves string-key
  insertion order), **never** a sort. Sorting reorders real dependencies.
- Do not add a `CHECK` or `UNIQUE` on a parsed integer version column.
- Do not assume `count == max(prefix)`.

## Files

| File | Change |
|---|---|
| `packages/api/src/db/schema.ts` | Add migration `266_create_schema_migrations`. Export `getMigrationEntries()` returning ordered `{name, sql}`. Keep `getMigrationSQL()` for the baseline path and existing callers. |
| `packages/api/src/db/migrate.ts` | Ledger read, baseline-on-empty, pending-only apply, per-migration record. |
| `packages/api/test/integration/migration-ledger.test.ts` | New. Cold apply, baseline, pending-only, replay-is-noop, concurrent deploys. |
| `packages/api/test/db/migration-ordering.test.ts` | New. Pins duplicate prefixes, gaps, and insertion≠sorted so the trap cannot regress. |
| `packages/api/test/integration/global-setup.ts` | Route through the same path the deploy uses, so tests exercise the real thing. |
| `scripts/prod-schema-probe.sql` | Delete the "there is no schema_migrations version table" note once the ledger ships. |
| `docs/deployment.md` | Document the ledger, baselining, and the manual-intervention runbook. |

---

## Tasks

### Task 1 — Ledger table and ordered accessor

- [ ] Add migration `266_create_schema_migrations`:
      `name TEXT PRIMARY KEY`, `applied_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
      `checksum TEXT NOT NULL`, `duration_ms INTEGER`.
      No `tenant_id` and no RLS — this is infrastructure, not tenant data.
      State that exemption in a comment so it does not read as an oversight
      against the repo's tenancy rule.
- [ ] Export `getMigrationEntries(): Array<{name: string, sql: string}>` from
      `schema.ts`, preserving `Object.keys` order and applying the same two
      rewrites `getMigrationSQL()` applies.
- [ ] `getMigrationSQL()` stays and is implemented in terms of
      `getMigrationEntries()` so the two cannot drift.
- [ ] Checksum = SHA-256 of the **post-rewrite** SQL. Rewriting is
      deterministic, so hashing the output keeps the ledger honest about what
      actually ran.

### Task 2 — Ordering-trap regression test

- [ ] `test/db/migration-ordering.test.ts` asserting, against the real object:
      265 keys; exactly 6 duplicate numeric prefixes; gaps at 55/181/235;
      insertion order is **not** numeric-sorted; `getMigrationEntries()` order
      matches `Object.keys(MIGRATIONS)` exactly.
- [ ] Include a comment explaining that these assertions exist to stop someone
      "tidying" the ledger onto a numeric version column.

### Task 3 — Baseline and pending-only apply

- [ ] In `applyMigrations`, inside the existing advisory lock:
      1. `CREATE TABLE IF NOT EXISTS schema_migrations` (bootstrap, outside the
         ledger's own accounting).
      2. If the ledger is **empty** and the database already has application
         tables (probe for `tenants`), **baseline**: insert every migration name
         with `applied_at = now()` and `duration_ms = NULL`, apply nothing.
         Log loudly that a baseline occurred and how many rows were recorded.
      3. If the ledger is empty and the database is empty: apply everything,
         record each.
      4. Otherwise apply only names absent from the ledger, in
         `getMigrationEntries()` order, recording each with its duration.
- [ ] Keep `SET lock_timeout='5s'` / `SET statement_timeout='25s'` on the apply
      path. The per-migration budget is now far larger in practice; do not
      raise the cap without evidence.
- [ ] Keep `verifyCriticalConstraints` running after apply, unconditionally —
      including on the baseline path, where it is the only check that the
      assumed schema is really present.
- [ ] Checksum mismatch on an already-applied migration → **fail the deploy**
      with the migration name and both hashes. Editing shipped migration text
      is the mistake this catches.
- [ ] Integration test `migration-ledger.test.ts` covering:
      cold DB applies all 265 and records 265 rows;
      second run applies 0 and is a no-op;
      baseline path on a DB migrated the *old* way records 265 without
      re-applying;
      a new migration appended to the corpus applies alone;
      an edited already-applied migration fails on checksum;
      two concurrent `runMigrationsOnClient` calls serialize and apply once.

### Task 4 — Cut over the test harness

- [ ] Point `test/integration/global-setup.ts` at the same entry the deploy
      uses, so ~58 integration files exercise the real path on every run.
- [ ] Confirm the full integration suite is green and note the wall-clock
      delta. Cold apply dominates there (2.6 s), so expect roughly no change.

### Task 5 — Docs and the stale admission

- [ ] Delete the "there is no schema_migrations version table on the deploy
      path" line from `scripts/prod-schema-probe.sql:3` and replace it with how
      to query the ledger.
- [ ] `docs/deployment.md`: document the ledger, the one-time baseline, the
      checksum-mismatch failure and its remedy, and how to hand-insert a row if
      a migration is applied out of band.
- [ ] `docs/decisions.md`: record the decision, and record that the "scaling
      cliff" framing was measured and retired — so it does not get
      re-litigated from the old text.

### Task 6 — Ship

- [ ] `npx tsc --project tsconfig.build.json --noEmit` clean.
- [ ] Full API suite green.
- [ ] Integration suite green under Docker.
- [ ] **Staging rehearsal before production**: deploy to a staging database
      that was migrated the old way and confirm the baseline path records 265
      rows and applies nothing. This is the step that de-risks the change; do
      not skip it.

---

## Out of scope (explicit)

- **Splitting `schema.ts`.** 6,448 lines is its own problem; changing the
  migration *runner* and the migration *storage* in one PR is unreviewable.
- **Making the 16 data-touching migrations cheaper.** Once the ledger exists
  they run once and never again, which dissolves the issue without touching
  their SQL.
- **Removing the regex rewriter.** It still serves the baseline path and any
  hand re-run. Retire it only after the ledger has been live long enough to
  trust.
- **Raising `statement_timeout`.** There is 24.8 s of headroom. Raising it
  would only hide a regression.
- **Down-migrations.** Not needed, and a rollback story invites use.
