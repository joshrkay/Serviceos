---
title: "DB migrations require a superuser role (vector extension + FORCE RLS) — use MIGRATION_DATABASE_URL"
date: 2026-06-15
track: knowledge
problem_type: architecture-patterns
module: "packages/api/src/db/migrate.ts, packages/api/src/db/migrate-config.ts, packages/api/src/db/pool.ts, packages/api/src/db/schema.ts, railway.toml"
tags: ["migrations", "postgres", "rls", "pgvector", "extensions", "superuser", "railway", "deploy", "ci-vs-deploy"]
related: []
---

## Context / symptom
Railway `@serviceos/api` deploy fails at the `preDeployCommand`
(`node packages/api/dist/src/db/migrate.js`) while **all GitHub CI is green**
(including the Docker-gated integration `test` job, which applies the *same*
`getMigrationSQL()`). The deploy reaches "Deploying" (build succeeds) then fails.

## Root cause — the migration set needs a *superuser* role
`migrate.js` runs the entire `getMigrationSQL()` as one transaction. Two
statements require privileges a plain managed-Postgres app role does **not**
have:

1. **`CREATE EXTENSION vector`** (`schema.ts`, knowledge_chunks). `pgvector` is
   **not a "trusted" extension** (`pg_trgm` and `btree_gist` are), so only a
   superuser can create it → `ERROR: permission denied to create extension "vector"`.
2. **Data-fixup statements** (e.g. `UPDATE tenant_integrations …`) against tables
   with `FORCE ROW LEVEL SECURITY`. Superusers / `BYPASSRLS` roles skip RLS; a
   plain role evaluates the policy and trips on the unset GUC →
   `ERROR: unrecognized configuration parameter "app.current_tenant_id"`.

**Why CI is green but deploy is red:** the integration test's testcontainer
connects as a **superuser**; the managed deploy role is not one. This is the
classic "passes on superuser, fails on least-privilege" gap — a mocked/elevated
test DB cannot catch it.

**Trap:** *resetting* the preview DB removes a previously-provisioned `vector`
extension, so a fresh DB fails *immediately* at (1) instead of getting past it.

## Reproduce (no Docker needed — local PG + the real SQL)
```bash
node -e "console.log(require('./packages/api/dist/src/db/schema').getMigrationSQL())" > /tmp/m.sql
# as superuser  -> clean ✅   ;  as NOSUPERUSER NOBYPASSRLS role -> fails at vector, then at app.current_tenant_id
```

## Fix
Run migrations under an elevated connection without changing the app's runtime
role. `migrate.ts` now prefers `MIGRATION_DATABASE_URL` and falls back to
`DATABASE_URL` (`resolveMigrationConnectionString` in `migrate-config.ts`;
`createPool(connectionStringOverride?)`).

- **Deploy fix:** set `MIGRATION_DATABASE_URL` to the Postgres **superuser**
  (`postgres`) connection string for the environment. The app keeps its
  least-privilege `DATABASE_URL` at runtime.
- **Equivalent ops fix:** as a superuser, `CREATE EXTENSION vector;` once on the
  DB **and** `ALTER ROLE <app_role> BYPASSRLS;`, then deploy with the app role.

Verified end-to-end on a local PG16: app role → `permission denied to create
extension "vector"`; with `MIGRATION_DATABASE_URL`=superuser → "Migrations
completed successfully" (vector created, all tables built).
