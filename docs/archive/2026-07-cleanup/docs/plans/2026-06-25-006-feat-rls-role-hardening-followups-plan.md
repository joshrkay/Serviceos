# feat: RLS role-hardening follow-ups (deny-list + named cross-tenant sweep role)

**Created:** 2026-06-25
**Depth:** Deep
**Status:** plan

> The two deferred follow-ups from `docs/plans/2026-06-25-005-feat-rls-runtime-role-enforcement-plan.md`.
> Builds directly on the now-shipped `rls_app_runtime` role + the `RLS_RUNTIME_ROLE` flag.
> Only takes effect when that flag is enabled, so it ships with / after the 005 rollout.

## Summary
Two least-privilege/auditability refinements on top of the RLS runtime-role feature.
**(B)** `rls_app_runtime` currently has `GRANT … ON ALL TABLES` — including the RLS-EXEMPT
tables (`oauth_states`, `platform_deprovision_log`) which have no policy, so under the role a
tenant-path query could read every tenant's rows from them. Revoke that. **(A)** intentional
cross-tenant sweeps (`withClient` over tenant data) run as the raw connection principal,
indistinguishable from migrations and global-table reads; route them through a named
`rls_cross_tenant` role so the access is explicit and attributable.

## Problem Frame
After 005 the runtime access model is two modes: per-tenant (`rls_app_runtime`, RLS-enforced)
and "everything else" (the privileged connection principal). Two rough edges remain:
1. **A real leak vector via exempt tables.** Tables deliberately without RLS have no policy to
   filter them, yet `rls_app_runtime` was granted access to them by the broad `ALL TABLES`
   grant. A tenant-scoped query that touches `platform_deprovision_log` (cross-tenant ops/audit
   log) under the role would return all tenants' rows. Nothing does that today, but the grant
   makes it a one-line-away leak with no RLS backstop.
2. **Cross-tenant access is unattributable.** The proposal execution sweep and the
   `findAllActive` cursors deliberately read/write across tenants via `withClient` (the
   connection principal). In DB audit logs / monitoring they're indistinguishable from
   migrations, view-token `SECURITY DEFINER` calls, and global-table reads — so "is any
   cross-tenant access happening, and is it intentional?" can't be answered at the DB layer.

## Requirements
- R1. `rls_app_runtime` has table privileges **only** on tables that have an RLS policy; it has
  no grant on any tenant-exempt / non-RLS table (`oauth_states`, `platform_deprovision_log`,
  and the migration ledger). A test pins this invariant against the live schema.
- R2. The genuine cross-tenant sweeps (proposal execution sweep; `findAllActive` cursors) run
  under a named `rls_cross_tenant` role when `RLS_RUNTIME_ROLE=true`, and still see/write across
  all tenants (correctness preserved).
- R3. With `RLS_RUNTIME_ROLE` off, behavior is byte-for-byte today's (both changes are no-ops:
  the revoke still applies at the grant layer but the bypassing principal is unaffected; the
  sweep helper falls back to the plain connection principal).
- R4. Provisioning degrades gracefully: a deploy principal lacking `CREATEROLE`/`GRANT` (or
  `SUPERUSER`, needed for `BYPASSRLS`) logs a NOTICE and continues; the sweep helper then falls
  back to the connection principal.

## Key Technical Decisions
- **Deny-list = "tables with no RLS policy", not a per-table allow-list.** The principled rule:
  the RLS-subject role may hold grants only where a policy exists to scope it; a table with no
  policy must not be reachable by the role at all. This captures the real win (no cross-tenant
  read of exempt/ops tables) with a single testable invariant, and avoids the maintenance
  friction + missing-grant-500 landmine that the original "tighten to per-table" framing would
  reintroduce. (Alternative: full per-table allow-list — rejected; RLS already isolates the
  RLS-enabled tables, so an allow-list adds churn for ~no marginal security over the deny-list.)
- **The named cross-tenant role is auditability, not privilege reduction.** `rls_cross_tenant`
  must be `BYPASSRLS` (it reads/writes across tenants on FORCE-RLS tables) — the same capability
  as the connection principal. Its value is intent: cross-tenant access becomes an explicit,
  named, greppable/auditable role instead of "indistinguishable privileged query." Honest scope:
  meaningful mainly once DB audit logging exists and the runtime role is enabled. (Alternative:
  leave sweeps on the connection principal — rejected; it forecloses ever attributing intentional
  cross-tenant access, which is the whole point of the runtime-role direction.)
- **Reuse the 005 seam + flag.** A new `withCrossTenantSweep` helper mirrors `withClient` but
  `SET[ LOCAL] ROLE rls_cross_tenant` when the flag is on; gated on the same `RLS_RUNTIME_ROLE`
  and graceful-degrading like `applyTenantContext`. Only the genuine cross-tenant-over-tenant-data
  methods migrate to it — global-table `withClient` calls (vertical packs, feature flags,
  webhooks, queue) stay as-is (no tenant data, no RLS concern).

## Scope Boundaries
**In scope:** the `rls_app_runtime` deny-list + its invariant test; the `rls_cross_tenant` role +
`withCrossTenantSweep` helper; migrating the proposal execution sweep + `findAllActive` cursors;
enforcement tests; runbook update.
**Non-goals:**
- A full per-table allow-list for `rls_app_runtime` (explicitly decided against above).
- Changing the connection principal, or moving migrations / view-token `SECURITY DEFINER`
  functions / global-table access off it.
- Enabling DB-level audit logging itself (that's an infra/ops task; this just makes the role
  attributable when it's on).
### Deferred to follow-up work
- pgaudit / log_statement role-attribution config (ops).

## Repository invariants touched
- **RLS / `tenant_id`:** central. R1 closes a cross-tenant read vector on exempt tables; R2 keeps
  the intentional cross-tenant sweeps working under an explicit role. Must preserve every existing
  policy and the `withClient` privileged paths that legitimately hit global tables.
- **Audit events:** no new business-entity mutations. (`platform_deprovision_log` is itself the
  ops audit log — this plan only changes *who* can read it, not its writes.)
- Other invariants untouched.

## High-Level Technical Design
Three named runtime modes after this plan (all gated on `RLS_RUNTIME_ROLE`):

```
per-tenant queries        →  rls_app_runtime   (RLS-enforced; grants ONLY on RLS tables)   [005]
intentional cross-tenant  →  rls_cross_tenant  (BYPASSRLS; named + auditable)              [this plan, item A]
migrations / view-token fns / global-table reads  →  connection principal (unchanged)
```

`withClient` keeps serving the last row (global tables); only the cross-tenant-over-tenant-data
sweeps move to `withCrossTenantSweep` → `rls_cross_tenant`.

## Implementation Units

### U1. Deny `rls_app_runtime` access to non-RLS tables
- **Goal:** the RLS-subject role can never read/write a table that has no policy to scope it (R1).
- **Requirements:** R1, R3, R4
- **Dependencies:** none (refines 005's migration 217)
- **Files:** `packages/api/src/db/schema.ts` (new migration `219_rls_app_runtime_revoke_exempt`),
  `packages/api/test/db/migration-immutability.test.ts` (snapshot),
  `packages/api/test/integration/rls-runtime-audit.test.ts` (extend with the invariant).
- **Approach:** In a graceful `DO $$ … EXCEPTION WHEN insufficient_privilege` block,
  `REVOKE ALL ON <table> FROM rls_app_runtime` for the RLS-exempt tables (`oauth_states`,
  `platform_deprovision_log`) and the migration-ledger table (discover its name — see Open
  Questions). Keep the broad grant on everything else. The invariant test derives the set
  empirically: `role_table_grants(grantee='rls_app_runtime')` must be a subset of tables where
  `pg_class.relrowsecurity` is true — i.e. zero grants on any non-RLS table.
- **Patterns to follow:** migration 217's graceful `DO`/`EXCEPTION` block; the live-schema
  queries in `rls-runtime-audit.test.ts`; the exempt list in `schema.test.ts` (`RLS_EXEMPT_TABLES`).
- **Test scenarios:**
  - Integration (real Postgres): after migrations, `rls_app_runtime` has 0 table grants on any
    table with `relrowsecurity = false` (covers the exempt tables + the migration ledger).
  - Integration: under `rls_app_runtime`, `SELECT * FROM platform_deprovision_log` and
    `… FROM oauth_states` raise `permission denied` (not "returns all tenants' rows").
  - Regression: a normal tenant-table read/write under the role still succeeds (grant intact on
    RLS tables).
- **Verification:** the role provably cannot touch any non-RLS table; tenant-table access intact.

### U2. Provision `rls_cross_tenant` role + `withCrossTenantSweep` helper
- **Goal:** a named, auditable, flag-gated role for intentional cross-tenant access (R2, R3, R4).
- **Requirements:** R2, R3, R4
- **Dependencies:** none (parallel to U1)
- **Files:** `packages/api/src/db/schema.ts` (new migration `220_create_rls_cross_tenant_role`),
  `packages/api/test/db/migration-immutability.test.ts` (snapshot),
  `packages/api/src/db/rls-runtime-role.ts` (`withCrossTenantSweep` + extend the boot probe),
  `packages/api/src/db/pg-base.ts` (a `withCrossTenantSweep` protected method parallel to
  `withClient`), `packages/api/test/db/rls-runtime-role.test.ts` (helper unit test).
- **Approach:** Migration provisions `CREATE ROLE rls_cross_tenant NOLOGIN BYPASSRLS` + grants +
  `GRANT rls_cross_tenant TO current_user`, graceful on `insufficient_privilege` (note: `BYPASSRLS`
  needs SUPERUSER to create — degrade-and-fallback if absent). The helper acquires a pooled client
  and, when `RLS_RUNTIME_ROLE` is on, `SET ROLE rls_cross_tenant` (session) + `RESET ROLE` on
  release (mirror `applyTenantContext`/`clearTenantContext` lifecycle exactly — this is the
  pool-role-leak risk from 005, so reuse `clearTenantContext`). When off, it is plain `withClient`.
  Extend `verifyRlsRuntimeRole` to also assert `rls_cross_tenant` is assumable when the flag is on.
- **Patterns to follow:** `applyTenantContext`/`clearTenantContext`/`verifyRlsRuntimeRole` (005);
  `pg-base.withClient` (the method this parallels); migration 217 (provisioning shape).
- **Test scenarios:**
  - Unit: `withCrossTenantSweep` with flag OFF issues no `SET ROLE`; with flag ON issues
    `SET ROLE rls_cross_tenant` and resets on release.
  - Unit: the extended boot probe throws when `rls_cross_tenant` is unassumable + flag on; no-op off.
  - Integration: provisioned role is `BYPASSRLS=t`, `rolcanlogin=f`, assumable by the app principal.
- **Verification:** helper drops to / resets the named role correctly; boot refuses if flag on but role absent.

### U3. Route the genuine cross-tenant sweeps through `withCrossTenantSweep`
- **Goal:** intentional cross-tenant-over-tenant-data access runs under the named role (R2).
- **Requirements:** R2
- **Dependencies:** U2
- **Files:** `packages/api/src/proposals/pg-proposal.ts` (`findReadyForExecution`,
  `claimForExecution`, `resetStaleExecuting` — currently `withClient` with the explicit
  "Privileged cross-tenant sweep" comment), `packages/api/src/integrations/accounting/repository.ts`
  (`findAllActive`), and the other cross-tenant `findAllActive`/all-tenant cursors (calendar sync,
  dunning, reviews, weekly-feedback — enumerate during implementation; see Open Questions).
- **Approach:** Swap `this.withClient(...)` → `this.withCrossTenantSweep(...)` for ONLY the
  methods that read/write tenant tables across tenants. Do NOT touch `withClient` calls over
  global tables (vertical packs, feature flags, webhooks, queue, etc.). Each migrated method keeps
  its existing comment, updated to name the role.
- **Patterns to follow:** the proposal-sweep comment block already documents the intent; the
  `findAllActive`→per-tenant-`withTenant` cursor pattern (the cursor is cross-tenant, the
  per-tenant processing stays on `rls_app_runtime`).
- **Test scenarios:** covered by U4 (these methods exercised under the named role end-to-end).
  - System-wide check: confirm the executor's per-proposal work still runs per-tenant
    (`withTenant` → `rls_app_runtime`), i.e. only the claim/scan is cross-tenant.
- **Verification:** grep shows the cross-tenant-over-tenant-data methods use `withCrossTenantSweep`;
  global-table `withClient` calls are unchanged.

### U4. Enforcement integration test
- **Goal:** prove the named-role sweeps + the deny-list against real Postgres (R2, R3).
- **Requirements:** R2, R3
- **Dependencies:** U1, U2, U3
- **Files:** `packages/api/test/integration/rls-cross-tenant-sweep.test.ts`.
- **Approach:** With `RLS_RUNTIME_ROLE=true`, seed approved proposals under two tenants; run the
  proposal execution sweep and assert it finds/claims across both (cross-tenant works under
  `rls_cross_tenant`). Assert a `findAllActive` cursor returns rows for multiple tenants. Assert
  pool hygiene (after a sweep, a checked-out connection is back on the principal, not
  `rls_cross_tenant`). Flag-off: same paths still work on the connection principal.
- **Patterns to follow:** `test/integration/rls-runtime-role.test.ts` (the 005 enforcement test +
  its pool-hygiene assertion); `EXTERNAL_TEST_DB_URL` harness.
- **Test scenarios:**
  - Cross-tenant sweep under the named role sees proposals from both tenants; claim/UPDATE works.
  - Pool hygiene: no `rls_cross_tenant` leak to a subsequent checkout.
  - Flag-off: sweep behavior unchanged (connection principal).
  - (Cross-check U1) under `rls_app_runtime`, the exempt tables raise permission denied.
- **Verification:** all green with the flag on; cross-tenant correctness + no leak; flag-off unchanged.

### U5. Update the rollout runbook
- **Goal:** document the 3-mode model + provisioning both roles (R4).
- **Requirements:** R4
- **Dependencies:** U1, U2
- **Files:** `docs/runbooks/rls-runtime-role-rollout.md` (extend).
- **Approach:** Add `rls_cross_tenant` to the pre-flight provisioning (note `BYPASSRLS` needs
  SUPERUSER to create; provide the admin fallback SQL), document the deny-list invariant, and the
  3-mode model. Keep the instant flag-off rollback.
- **Test scenarios:** `Test expectation: none — operational runbook.`
- **Verification:** an operator can provision both roles and verify enforcement end-to-end.

## Risks & Dependencies
- **`BYPASSRLS` requires SUPERUSER to create.** Many managed Postgres setups withhold SUPERUSER
  from the app/migrate principal, so migration 220 will hit the graceful-degrade path and
  `rls_cross_tenant` won't exist → `withCrossTenantSweep` falls back to the connection principal
  (correct, just no attribution). The runbook must give the admin-run fallback SQL.
- **Pool role-leak (same hazard as 005).** `withCrossTenantSweep`'s session `SET ROLE` must reset
  on release via `clearTenantContext`; pinned by U4's pool-hygiene test.
- **Under-/over-migration in U3.** Migrating a global-table `withClient` to the cross-tenant role
  is harmless-but-wrong (mislabels intent); missing a genuine cross-tenant sweep leaves it on the
  principal (no attribution, still correct). Enumerate the cross-tenant-over-tenant-data set
  carefully (grep `withClient` + check whether the SQL targets a `tenant_id` table without a
  tenant filter).
- Migrations 219 + 220 each need an immutability-snapshot entry; watch for number collisions on merge.

## Open Questions (deferred to implementation)
- The exact name of the migration-ledger table to add to U1's deny-list (discover from the
  migration runner — `packages/api/src/db/migrate.ts`).
- The full set of `findAllActive`/all-tenant cursor methods beyond proposals + accounting
  (calendar sync, dunning, reviews, weekly-feedback) — enumerate by grepping cross-tenant cursors
  during U3.
- Whether `withCrossTenantSweep` should be transactional (`SET LOCAL ROLE`) for the sweep methods
  that run multi-statement work, vs session `SET ROLE` + reset (the proposal claim is multi-step).

## Sources & Research
- Deferred items: `docs/plans/2026-06-25-005-...` ("Deferred to follow-up work").
- `packages/api/src/proposals/pg-proposal.ts:374` — "Privileged cross-tenant sweep — uses
  withClient() intentionally" (the canonical cross-tenant method).
- `packages/api/src/db/schema.ts` migration 217 (grants), migration 218 + the exemption comments.
- `docs/solutions/architecture-patterns/rls-exempt-tables-read-before-tenant-context.md` (why the
  exempt tables exist — exactly the tables U1 must revoke).
- ~20 `withClient` files surveyed; most are global-table access (out of scope), only the proposal
  sweep + `findAllActive` cursors are cross-tenant-over-tenant-data (in scope for U3).
