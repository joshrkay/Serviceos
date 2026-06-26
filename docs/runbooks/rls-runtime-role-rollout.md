# Runbook — Enabling RLS runtime-role enforcement

**What this enables:** the API drops to a least-privilege, RLS-subject Postgres
role (`rls_app_runtime`) for every tenant-scoped query, so Row-Level Security
actually enforces at runtime — a forgotten `WHERE tenant_id = $` filter can no
longer cross tenants. Today the app connects as a privileged (`BYPASSRLS`)
principal, so RLS is a no-op; this is the second line of defense behind the
app-layer tenant filters.

**Control:** the `RLS_RUNTIME_ROLE` env var. **Default off** — deploying the
code changes nothing until you set it. **Rollback is instant:** unset the var
and redeploy/restart; no migration required.

**Safety property:** if `RLS_RUNTIME_ROLE=true` but the `rls_app_runtime` role
is not assumable by the app's DB principal, the app **refuses to boot** (a
startup probe fails fast). You can never run with the flag on and enforcement
silently absent.

---

## Pre-flight — confirm the role is provisioned (one-time, before enabling)

Migration `217_create_rls_app_runtime_role` provisions the role automatically
**if** the migrating DB principal has `CREATEROLE` + `GRANT` rights. The
migration is self-degrading: a principal without those rights logs
`NOTICE: rls_app_runtime not provisioned (insufficient privilege)` and the
deploy still succeeds — but enforcement then stays off until the role exists.

1. Deploy the code as usual (with `RLS_RUNTIME_ROLE` **unset**). Migrations run.
2. Check whether the role exists and is assumable by the app principal:
   ```sql
   -- as the app's DB user (the one in DATABASE_URL):
   SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'rls_app_runtime';
   -- expect one row: rolbypassrls = f, rolcanlogin = f
   SET ROLE rls_app_runtime; RESET ROLE;  -- must succeed (membership granted)
   ```
3. **If the role is missing or `SET ROLE` fails** (managed Postgres often
   withholds `CREATEROLE` from the app user), have an admin/superuser provision
   it once:
   ```sql
   CREATE ROLE rls_app_runtime NOLOGIN;
   GRANT USAGE ON SCHEMA public TO rls_app_runtime;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_app_runtime;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rls_app_runtime;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rls_app_runtime;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rls_app_runtime;
   GRANT rls_app_runtime TO <the app's DB user>;
   ```
   (This is exactly what migration 217 attempts; running it as an admin is the
   fallback when the migrate principal can't.)

4. **Also provision the cross-tenant role** (`rls_cross_tenant`). Migration 220
   creates it, but `BYPASSRLS` requires **SUPERUSER**, which managed Postgres
   often withholds — so this one frequently needs the admin fallback. When the
   flag is on, the boot probe verifies BOTH roles and refuses to start if either
   is missing.
   ```sql
   -- run as a superuser:
   CREATE ROLE rls_cross_tenant NOLOGIN BYPASSRLS;
   GRANT USAGE ON SCHEMA public TO rls_cross_tenant;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_cross_tenant;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rls_cross_tenant;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rls_cross_tenant;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rls_cross_tenant;
   GRANT rls_cross_tenant TO <the app's DB user>;
   ```
   If it can't be provisioned, the intentional cross-tenant sweeps (proposal
   execution, recovery/retention drains) fall back to the connection principal —
   correct, just unattributed.

### The three runtime access modes (with the flag on)
- **Per-tenant** → `rls_app_runtime` (RLS-enforced; migration 219 revokes its
  grants on the RLS-exempt tables so it can't read them cross-tenant).
- **Intentional cross-tenant sweeps** → `rls_cross_tenant` (BYPASSRLS; named so
  the access is attributable in DB audit logs).
- **Migrations / view-token `SECURITY DEFINER` functions / global-table reads**
  → the connection principal (unchanged).

## Rollout

1. **Staging first.** Set `RLS_RUNTIME_ROLE=true` in staging and restart.
   - The boot probe must pass (app comes up). If it crashes with
     "`rls_app_runtime` is not assumable", the role isn't provisioned/granted —
     go back to Pre-flight.
   - Smoke the lead-to-cash flow end-to-end (create customer → job → estimate →
     send → approve → invoice → pay) and exercise a worker/digest path. Watch
     logs for `permission denied for table ...` — that signals a missing grant
     (shouldn't happen; grants are `ON ALL TABLES` + default privileges). If one
     appears, grant it to `rls_app_runtime` and note the table.
2. **Production.** Once staging is clean, set `RLS_RUNTIME_ROLE=true` in prod and
   restart. Watch error rates + DB permission errors for the first deploy.

## Verify enforcement is live

```sql
-- as the app DB user, simulating a tenant-scoped query:
SET ROLE rls_app_runtime;
SET app.current_tenant_id = '<tenant-B-id>';
SELECT count(*) FROM customers WHERE id = '<a-known-tenant-A-customer-id>';  -- expect 0
RESET app.current_tenant_id;
SELECT count(*) FROM customers;  -- expect 0 / error (fails closed)
RESET ROLE;
```

## Rollback

Unset `RLS_RUNTIME_ROLE` (or set it to anything other than `true`) and restart.
The app immediately reverts to today's behavior (GUC set, no role drop). No
migration, no data change. The `rls_app_runtime` role can be left provisioned.

## Notes / known scope
- The privileged cross-tenant sweeps (`findReadyForExecution`, admin tenant
  tooling) use `withClient` and intentionally stay on the connection principal —
  they continue to see all tenants by design.
- The public estimate/invoice pages use `SECURITY DEFINER` token-lookup
  functions (migration 119) that run as the function owner, so they are
  unaffected by the role drop.
- `platform_deprovision_log` is intentionally exempt from RLS (ops/audit log,
  must survive tenant purge) — see its table comment.
- Implementation + proof: `docs/plans/2026-06-25-005-feat-rls-runtime-role-enforcement-plan.md`,
  `packages/api/test/integration/rls-runtime-role.test.ts`.
