# Launch-Readiness Pass — DECISIONS

Audit trail for choices that the directive flagged as requiring justification
(new dependencies, schema changes).

## New npm dependencies
**None.** No package was added in this pass. All work reuses existing libraries
(zod, pg, vitest, supertest, express) already in the workspace.

## Schema changes (authorized)
The original directive forbade schema changes (defer instead). The user
explicitly overrode this by selecting **"Everything, incl. new features"** for
fix-depth, which calls out that schema changes may be required. Changes are added
as canonical in-code migrations in `packages/api/src/db/schema.ts` (NOT the
prototype-only `supabase_migration.sql`).

- **Migration `146_tenant_settings_bill_labor_from_time_entries`** (Feature 6):
  `ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS
  bill_labor_from_time_entries BOOLEAN NOT NULL DEFAULT false`.
  - Additive, default-off, opt-in. No behavior change for existing tenants.
  - `tenant_settings` already carries `ENABLE`+`FORCE` RLS, so no policy change
    is needed and the pinned RLS invariant (`test/db/schema.test.ts`,
    `test/integration/rls-tenant-isolation.test.ts`) is preserved.
  - Mapped in `settings.ts` (interfaces) and `pg-settings.ts` (read + write).

No new tenant-scoped tables were introduced in this pass, so the
every-tenant_id-table-has-RLS invariant is not otherwise affected.
