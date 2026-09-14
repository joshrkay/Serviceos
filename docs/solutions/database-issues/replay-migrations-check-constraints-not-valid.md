---
title: "Replay-every-boot migrations: every ADD CONSTRAINT … CHECK must be NOT VALID or a stale copy bricks deploys"
date: 2026-09-05
track: bug
problem_type: database-issues
module: packages/api/src/db
tags: ["postgres", "migrations", "check-constraint", "not-valid", "deploy-blocker", "sqlstate-23514", "schema"]
related: ["docs/plans/2026-09-05-001-fix-top-5-production-issues-plan.md#u9", "#923"]
---

## Problem

The migration runner (`packages/api/src/db/migrate.ts`, `applyMigrations`)
has **no applied-migrations ledger**. `getMigrationSQL()` concatenates every
entry of `MIGRATIONS` and the runner executes the whole corpus as one
statement on **every boot**, under a single `statement_timeout = '25s'`.
`getMigrationSQL()` also rewrites every `ALTER TABLE t ADD CONSTRAINT n` into
`ALTER TABLE t DROP CONSTRAINT IF EXISTS n; ALTER TABLE t ADD CONSTRAINT n`
so re-runs are idempotent.

Consequence: **every CHECK constraint in the corpus is dropped and re-added
on every deploy**, in corpus order. A bare `ADD CONSTRAINT … CHECK (…)`
(without `NOT VALID`) makes Postgres validate the **whole table** at that
point in the corpus, against **that migration's** vocabulary — not the final
one.

When a constraint has been widened (`069_extend_leads_source_check` →
`191_extend_leads_source_check_sms`; `039_proposals_v2` →
`072_add_executing_status`; six widenings of
`message_dispatches_entity_type_check`), the stale narrower copy replays
first. One row carrying a value only the later widening allows — a lead with
`source = 'sms'`, a proposal in `executing` — makes the early copy fail
validation, and the deploy dies with:

```
SQLSTATE 23514  check constraint "<name>" of relation "<table>" is violated by some row
routine: ATRewriteTable   in applyMigrations
```

Every subsequent deploy of `main` fails the same way until the schema is
patched. This bricked deploys three times on
`message_dispatches_entity_type_check` (190/269/270; fixed in `0c9bd4c`)
before the schema-wide sweep. Even a constraint that was never widened pays a
full validating table scan per deploy inside the shared 25-second budget.

## Symptoms

- Pre-deploy migration step fails with SQLSTATE 23514 naming a CHECK
  constraint, with `ATRewriteTable` in the routine — on a schema that has
  not changed since the last successful deploy.
- The failing constraint's **final** definition in `schema.ts` allows the
  offending value; an **earlier** migration's copy of the same constraint
  does not.
- Migration wall time creeping toward the 25s `statement_timeout` as tables
  grow, with no new migrations.

## Fix

Append `NOT VALID` before the terminating `;` of every
`ADD CONSTRAINT … CHECK (…)`:

```sql
ALTER TABLE leads ADD CONSTRAINT leads_source_check
  CHECK (source IN ('web_form', …, 'sms')) NOT VALID;
```

`NOT VALID` skips the existing-row scan while still enforcing the CHECK on
every future INSERT/UPDATE — exactly the semantics a replayed corpus needs.
The final copy in the corpus is the one that ends up live, so the effective
constraint is unchanged for new writes.

**Edit in place; do not add a migration; do not change the runner.**
A drop-and-re-add migration would add permanent extra `ALTER TABLE` round
trips to every boot. Editing a shipped migration trips
`test/db/migration-immutability.test.ts` on purpose — regenerate the affected
`SNAPSHOT` hashes with the `REGEN_HINT` one-liner documented in that file
(precedent: `0c9bd4c`, then the U9 sweep of all 26 remaining sites).

## Prevention (pinned in CI)

- `packages/api/test/db/check-constraints-not-valid.test.ts` — scans
  `getMigrationSQL()` for every `ADD CONSTRAINT <name> CHECK` (both the
  one-line `ALTER TABLE t ADD CONSTRAINT n` layout and the multi-clause
  `DROP CONSTRAINT …, ADD CONSTRAINT …` layout), pins the total site count
  (a regex regression fails loudly instead of passing vacuously), and fails
  naming `migrationKey: constraintName` for any site without `NOT VALID`.
  A new migration adding a bare CHECK fails this test.
- `packages/api/test/db/dispatch-entity-type-vocabulary.test.ts` — for each
  constraint with a single exported TS vocabulary
  (`message_dispatches_entity_type_check` ↔ `DispatchEntityType`,
  `jobs_status_check` ↔ `JobStatus`, `leads_source_check` ↔ `LEAD_SOURCES`),
  asserts every definition is `NOT VALID` and the **last** definition equals
  the TS union in both directions. Adding a TS member without widening the
  constraint (or vice versa) fails naming the value.

## Gotchas

- `NOT VALID` is only a keyword on `ADD CONSTRAINT` for CHECK and FOREIGN
  KEY; it does not apply to UNIQUE/EXCLUDE/PRIMARY KEY. The scan deliberately
  matches `ADD CONSTRAINT <name> CHECK` only. Inline column checks
  (`ADD COLUMN … CHECK (…)`) are not named constraints and are not
  replayed via DROP/ADD.
- A regex that requires a literal newline before `CHECK` (the original
  `ENTITY_TYPE_CHECK_RE`) silently misses the one-line layout. Use `\s+`
  and pin the match count.
- Widening a vocabulary needs BOTH the new migration (with `NOT VALID`) and
  the TS union change in the same commit, or the vocabulary pin fails.
