# Supabase Postgres Host Setup (canonical product)

Use Supabase **only as managed Postgres** for `packages/api` + `packages/web`. Auth remains **Clerk**; data access remains **`pg`** with app-layer RLS (`app.current_tenant_id`).

## Prerequisites

- Supabase project with **pgvector** enabled (Dashboard → Database → Extensions → `vector`)
- Connection string (prefer **transaction pooler** for Railway/serverless API)

## Steps

1. Set `DATABASE_URL` in Railway (or local `.env`) to the Supabase connection string.
2. Apply canonical migrations (never Sprint 1 SQL):

   ```bash
   npm --prefix packages/api run migrate:apply
   ```

3. Confirm RLS: all tenant tables should have policies using `app.current_tenant_id` (set per request in [tenant-context.ts](../packages/api/src/middleware/tenant-context.ts)).

4. Run security advisors (Supabase Dashboard or MCP `get_advisors`) after first deploy.

## Do not

- Run [supabase_migration.sql](../supabase_migration.sql) on this database.
- Expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.
- Expect `@supabase/supabase-js` in `packages/api` — it is intentionally absent.

## Training / legacy

- [serviceos_training](../serviceos_training/) may use a **separate** Supabase project and `training_corpus` table.
- [service-os-app](../service-os-app/) is legacy; route tenant data through the Express API when possible.

## Portal token lookup

Migration `107_portal_sessions_system_lookup_rls` requires token resolution to set:

```sql
SELECT set_config('app.portal_token_lookup', 'true', true);
```

before `SELECT` by `token_hash` (see [pg-portal-session.ts](../packages/api/src/portal/pg-portal-session.ts)).
