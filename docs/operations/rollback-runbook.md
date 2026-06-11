# Rollback Runbook (P7-022)

## When to roll back

- Production error rate spike after a deploy
- Failed migration or schema mismatch on startup
- Payment or auth regression blocking all tenants

## Railway API service

1. Open the Railway project → **api** service → **Deployments**.
2. Select the last known-good deployment → **Redeploy** (or promote previous image).
3. Confirm `/health` and `/ready` return 200 on the public URL.
4. Run `npm run smoke-test --workspace=packages/api` against staging before re-attempting prod.

## Database migrations

Migrations are **forward-only** in [schema.ts](../../packages/api/src/db/schema.ts). Rolling back application code does not revert SQL.

- If a migration partially applied, inspect `schema_migrations` and fix manually in a maintenance window.
- Never run [supabase_migration.sql](../../experiments/supabase_migration.sql) on the canonical database.

## Web (Vite static)

Redeploy the previous successful **web** build from Railway/Vercel history.

## Communication

- Note incident start/end, deploy SHA rolled back to, and whether data repair was required.
- File a follow-up story for root cause before re-deploying the failed change.
