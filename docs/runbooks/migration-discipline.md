# Migration Discipline

All schema migrations must be **additive** or **backfill-only**. Destructive
changes require a two-step deploy with explicit reviewer approval.

## Why

`railway rollback` reverts application code, not the database. If a deploy
ships both a destructive migration (`DROP COLUMN`, `RENAME`, etc.) and code
that depends on the new shape, rolling back the code re-introduces queries
against the now-missing column — and we have an outage.

## Source of truth

Migrations live as TypeScript template-literal strings inside the `MIGRATIONS`
object in `packages/api/src/db/schema.ts`. The `.sql` files in
`packages/api/src/db/migrations/` are documentation copies only — they are NOT
executed at runtime. `getMigrationSQL()` concatenates `Object.values(MIGRATIONS)`
in insertion order and runs them on app startup.

## Allowed in a single deploy

- `CREATE TABLE`, `CREATE INDEX`, `CREATE TYPE`
- `ALTER TABLE ... ADD COLUMN` (nullable, or with a default)
- Backfill `UPDATE` statements
- `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID` (validate in a later deploy)

## Requires a two-step deploy

- `DROP TABLE`, `DROP COLUMN`, `DROP INDEX`
- `RENAME` of anything (column, table, constraint)
- `ALTER COLUMN TYPE` that requires a rewrite (e.g., `int → uuid`)
- Adding `NOT NULL` to an existing column without a default

### Two-step pattern

**Step 1 (deploy A):** add the new shape alongside the old. Backfill. Switch
reads to the new shape. Ship. Wait ≥ 1 day so the change is visible across
all live instances and any rollback target.

**Step 2 (deploy B):** once you've confirmed no code reads the old shape and
no rollback target needs it, drop the old shape.

## PR reviewer checklist

If the diff includes any pattern from "Requires a two-step deploy":

- [ ] Confirmed this is step 2 of a two-step (step 1 was deployed and stable for ≥ 1 day), **OR**
- [ ] PR description explicitly justifies why a one-step is safe; author + reviewer both sign off.

## Permissive guard test

`packages/api/test/db/migration-discipline.test.ts` (Task 17) scans the newest
migration's SQL for destructive patterns and prints a `console.warn` if any
match. **The test does not fail** — judgment lives with the reviewers. The
warning's purpose is to make the policy visible in CI output so reviewers
notice and apply this checklist.

## Migration immutability

`packages/api/test/db/migration-immutability.test.ts` enforces SHA-256 hashes
on every shipped migration. Mutating a migration value requires updating the
snapshot, which forces the author to consciously think about whether the
change is pre-deploy (snapshot bump is fine) or post-deploy (must be a new
migration). Renaming or removing migration keys is forbidden.
