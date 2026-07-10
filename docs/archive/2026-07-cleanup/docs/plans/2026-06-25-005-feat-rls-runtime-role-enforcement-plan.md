# feat: Enforce tenant RLS at runtime via a least-privilege database role

**Created:** 2026-06-25
**Depth:** Deep
**Status:** plan

> Focused execution of U4 from `docs/plans/2026-06-25-004-fix-beta-verification-open-findings-plan.md`,
> which was deferred there as too risky to land inline. The mechanism was **spiked and validated**
> this session (see Sources). Finding origin: `docs/verification-runs/beta-verification-2026-06-25.md` #5.

## Summary
Today the API connects to Postgres as a superuser (`rolbypassrls=t`), so every Row-Level-Security
policy is a runtime no-op — tenant isolation rests entirely on application-layer `WHERE tenant_id = $`
filters. This plan makes RLS a real second line of defense: the app drops to a least-privilege,
RLS-subject role (`rls_app_runtime`) for the duration of every tenant-scoped query, so a single
forgotten tenant filter can no longer leak across tenants. Activation is opt-in and verified-or-refuse,
so it cannot silently half-apply or break a deploy.

## Problem Frame
The 2026-06-25 verification proved RLS is currently inert at runtime: as the app's `postgres`
connection, `SET app.current_tenant_id = '<B>'; SELECT * FROM customers WHERE id = '<A-customer>'`
returns A's row, and an unset GUC returns **all** tenants' rows. The policies themselves are correct
(they enforce when the same query runs as a non-superuser role), but nothing in the app ever assumes
such a role. Anyone who ships a repo query missing its `tenant_id` filter (and several have shipped —
the execution worker's privileged sweep is intentional, but mistakes are not caught) crosses tenants
with no backstop. This affects every tenant's data confidentiality.

## Requirements
- R1. With enforcement active, a tenant-scoped query for tenant B cannot read or write tenant A's rows
  even if the SQL omits a `tenant_id` predicate — RLS returns 0 rows / blocks the write.
- R2. An unset tenant GUC under the runtime role fails closed (0 rows or error), never returns all rows.
- R3. Every existing app query path still succeeds under the runtime role (no missing-grant 500s):
  the full lead-to-cash flow, workers, public flows, voice, digests, analytics.
- R4. Intentional cross-tenant operations (admin sweeps, `findReadyForExecution`, global reference
  tables) keep working — they run on the privileged connection, not the runtime role.
- R5. Activation is explicit and safe: if enabled but the role isn't assumable, the app refuses to boot
  (no false sense of security); if disabled, behavior is byte-for-byte today's. The provisioning
  migration never breaks a deploy on a principal lacking `CREATEROLE`.
- R6. The two tenant tables without RLS (`oauth_states`, `platform_deprovision_log`) are either brought
  under RLS or explicitly documented as intentional exemptions.

## Key Technical Decisions
- **Centralize tenant-context establishment into one seam, then add the role drop there** — rather than
  editing ~12 `setTenantContext` call sites individually. Introduce `applyTenantContext(client, tenantId)`
  / `clearTenantContext(client)` and migrate all callers + the request middleware to them. *Altitude:*
  the GUC is currently set two different ways (session `SET` via `setTenantContext`, and `SET LOCAL`
  via `set_config` in the middleware); unifying them is the only way to apply the role uniformly and
  is a correctness win on its own. (Alternative: patch each site — rejected; N places to forget, and it
  leaves the two mechanisms divergent.)
- **Provision the role in a migration, idempotent + self-degrading** (`DO $$ … EXCEPTION WHEN
  insufficient_privilege THEN RAISE NOTICE …`). The migration runs on every boot; it must never abort
  the deploy if the prod principal can't `CREATE ROLE`/`GRANT`. (Alternative: provision out-of-band via
  infra/ops only — rejected as the source of truth; keep it in migrations, but tolerant.)
- **Grant broadly, enforce by RLS** — `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES` (+ sequences +
  `ALTER DEFAULT PRIVILEGES` for future tables) to `rls_app_runtime`. The role is *not* `BYPASSRLS` and
  *not* a table owner, so RLS still filters every access; broad grants just eliminate the missing-grant
  500 risk (R3). (Alternative: hand-pick per-table grants — rejected as fragile; a new table would
  silently 500 until someone remembers the grant.)
- **Opt-in via `RLS_RUNTIME_ROLE=true`, verified-or-refuse at boot.** Default off → zero behavior change,
  safe to land. When on, a startup probe asserts the role is assumable (`SET ROLE rls_app_runtime; RESET
  ROLE`) and the app **refuses to boot** if not — you can never run with the flag on but enforcement
  silently absent. (Alternative: auto-detect-and-enable — rejected; flipping a security control
  implicitly on role existence surprises operators and couples rollout to migration timing.)
- **`withClient` stays privileged.** Cross-tenant sweeps (`findReadyForExecution`, admin tenant tooling)
  deliberately bypass RLS and must not route through the new seam.

## Scope Boundaries
**In scope:** provisioning `rls_app_runtime`; centralizing tenant-context + the flag-gated role drop;
closing the 2 RLS gaps; the enforcement integration test; the ops rollout runbook.
**Non-goals:**
- Switching the app's *connection* principal (it must stay privileged to run migrations and own the
  `SECURITY DEFINER` view-token functions — migration `119`). We drop privilege per-query, not globally.
- A full audit of every repo for missing `tenant_id` filters (RLS becomes the backstop; an audit is
  separate).
- Changing the public-page path (`find_*_by_view_token` `SECURITY DEFINER` functions run as owner and
  are unaffected — verified in the spike).
### Deferred to follow-up work
- Tightening grants from "ALL TABLES" to per-table once the surface is proven stable.
- Making the privileged cross-tenant sweeps assume a *named* elevated role (vs. the raw connection role)
  for auditability.

## Repository invariants touched
- **RLS / `tenant_id`:** this plan is precisely about making the RLS invariant real at runtime; it must
  preserve every existing policy and the `current_setting('app.current_tenant_id')::uuid` predicate
  shape, and keep `withClient` (intentional cross-tenant) privileged.
- **Audit events:** no business-entity mutations are added; the role/seam change emits no audit events
  (infrastructure). The centralization must not drop the existing GUC-leak `RESET` behavior.
- Other invariants (cents, LLM gateway, proposals, catalog/entity resolvers): untouched.

## High-Level Technical Design

Two ways the tenant GUC is established today, to be unified behind one seam:

1. `setTenantContext(tenantId)` → returns `SET app.current_tenant_id = '<uuid>'`; run via
   `client.query(...)` at ~12 sites (`pg-base.ts` ×2, `voice/*`, `digest/*`, `webhooks/integration-resolver`,
   `workers/provision-twilio`, `analytics/jobs-booked`). Session-level; callers `RESET` before release.
2. `middleware/tenant-context.ts` → `BEGIN` + `SELECT set_config('app.current_tenant_id', $1, true)`
   (SET LOCAL, auto-reset at COMMIT/ROLLBACK).

After: both go through `applyTenantContext(client, tenantId, { transactional })` which sets the GUC the
same way it does today **and**, when `RLS_RUNTIME_ROLE` is active, additionally issues `SET [LOCAL] ROLE
rls_app_runtime`. `clearTenantContext` resets both GUC and role for the session (non-transactional)
path; the transactional path relies on COMMIT/ROLLBACK auto-reset. `withClient` is untouched (privileged).

```
request ─▶ tenant-context mw ─▶ applyTenantContext(client, tid, {transactional:true})  ─┐
workers/voice/digests ─▶ pg-base.withTenant/withTenantTransaction ─▶ applyTenantContext ─┼─▶ GUC + (flag) SET ROLE rls_app_runtime
                                                                                          │
cross-tenant sweeps ─▶ pg-base.withClient ───────────────────────────────────────────────┘ (privileged, no role drop)
```

## Implementation Units

### U1. Provision `rls_app_runtime` (idempotent, self-degrading migration)
- **Goal:** Create the RLS-subject role with broad grants and grant membership to the connection
  principal, without ever breaking a deploy (R5).
- **Requirements:** R1, R3, R5
- **Dependencies:** none
- **Files:** `packages/api/src/db/schema.ts` (new migration `NNN_create_rls_app_runtime`),
  `packages/api/test/db/migration-immutability.test.ts` (snapshot the new migration).
- **Approach:** In a `DO $$ … END $$` block: `CREATE ROLE rls_app_runtime NOLOGIN` if absent (NOT
  `BYPASSRLS`, NOT `SUPERUSER`); `GRANT USAGE ON SCHEMA public`; `GRANT SELECT,INSERT,UPDATE,DELETE ON
  ALL TABLES IN SCHEMA public`; `GRANT USAGE,SELECT ON ALL SEQUENCES`; `ALTER DEFAULT PRIVILEGES …` for
  future tables/sequences; `GRANT rls_app_runtime TO current_user`. Wrap in
  `EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE` so a principal lacking `CREATEROLE` logs and
  continues instead of aborting. Mirror the idempotent-DDL style of migration `119`/`196`.
- **Patterns to follow:** `119_view_token_lookup_functions` (conditional `DO $$` create), `196_create_device_tokens` (RLS table conventions).
- **Test scenarios:**
  - Integration (real Postgres, see U4 harness): after migrations, `pg_roles` has `rls_app_runtime` with `rolbypassrls=f`, `rolcanlogin=f`; the connection role is a member; a representative table is selectable under `SET ROLE rls_app_runtime`.
  - Idempotency: applying the full migration set twice does not error.
  - Degrade path: documented + asserted at the SQL level that the `EXCEPTION` block swallows `insufficient_privilege` (can be simulated by running as a non-CREATEROLE role in the integration test if feasible; else Open Question).
- **Verification:** a freshly-migrated DB has the role provisioned and grantable; re-migrating is a no-op.

### U2. Close the two RLS coverage gaps
- **Goal:** Bring `oauth_states` and `platform_deprovision_log` under RLS, or document exemption (R6).
- **Requirements:** R6
- **Dependencies:** none
- **Files:** `packages/api/src/db/schema.ts` (new migration adding `ENABLE ROW LEVEL SECURITY` +
  `tenant_isolation_*` policy per table, matching the standard predicate), immutability snapshot.
- **Approach:** Confirm each table is genuinely tenant-scoped. `oauth_states` (OAuth flow state) →
  add the standard `tenant_id = current_setting('app.current_tenant_id')::uuid` policy. For
  `platform_deprovision_log` (ops/admin) → determine whether it's read via `withClient` (privileged,
  cross-tenant) by design; if so, document the exemption in the migration comment instead of a policy,
  otherwise add the policy. Decide per-table from how each is accessed.
- **Patterns to follow:** the `tenant_isolation_<table>` policy blocks already in `schema.ts`.
- **Test scenarios:**
  - Integration: under `rls_app_runtime` + GUC=tenant B, a row inserted for tenant A in each newly-covered table returns 0 rows; unset GUC → 0 rows/error.
  - If a table is exempted, a test/comment asserts the access path is `withClient`-only.
- **Verification:** the `tenant_tables WHERE NOT relrowsecurity` count drops to 0 (or only documented exemptions remain).

### U3. Centralize tenant-context + flag-gated role drop
- **Goal:** One seam sets GUC (+ optional role) for every tenant-scoped query; default-off flag makes
  this a behavior-preserving refactor until enabled (R1, R2, R4, R5).
- **Requirements:** R1, R2, R4, R5
- **Dependencies:** U1 (role must exist for the probe to pass when enabled; refactor itself is independent)
- **Files:**
  - `packages/api/src/db/schema.ts` or a new `packages/api/src/db/tenant-context.ts` — `applyTenantContext`/`clearTenantContext` + the `RLS_RUNTIME_ROLE` flag + the startup capability probe.
  - `packages/api/src/db/pg-base.ts` — `withTenant`/`withTenantTransaction` call the helper; preserve the GUC-leak `RESET` (now also `RESET ROLE`).
  - `packages/api/src/middleware/tenant-context.ts` — use the helper (transactional variant).
  - The ~10 other `setTenantContext` callers: `voice/voice-service.ts`, `voice/outbound-consent.ts`, `digest/weekly-feedback-builder.ts`, `digest/digest-builder.ts`, `webhooks/integration-resolver.ts`, `workers/provision-twilio.ts`, `analytics/jobs-booked.ts` — migrate to the helper.
  - `packages/api/src/index.ts` (or `app.ts` boot) — run the probe; refuse to boot if `RLS_RUNTIME_ROLE=true` and the role isn't assumable.
  - Remove the now-dead `setTenantContext` export if no caller remains (re-grep first).
  - Tests: `packages/api/test/db/tenant-context-helper.test.ts`.
- **Approach:** Keep the exact GUC SQL each path uses today (session `SET` vs `SET LOCAL` via
  `set_config`) — the helper just wraps it and conditionally appends the role statement (`SET LOCAL ROLE`
  inside the middleware/transaction path; session `SET ROLE` + explicit `RESET ROLE` on the pooled
  non-transaction path, alongside the existing `RESET app.current_tenant_id`). Flag read once at module
  load. The probe acquires a connection at boot, tries `SET ROLE rls_app_runtime; RESET ROLE`, and on
  failure with the flag on, throws to abort startup.
- **Patterns to follow:** the existing GUC-leak `RESET` lifecycle in `pg-base.ts`; the `AsyncLocalStorage`
  ctx reuse in `middleware/tenant-context.ts` (the role must be set on `ctx.client` too, in the middleware).
- **Test scenarios:**
  - Unit: `applyTenantContext` with flag OFF emits only the GUC statement (no `SET ROLE`); with flag ON emits GUC + role; `clearTenantContext` resets both.
  - Unit: the probe throws when the role is unassumable + flag on; no-ops when flag off.
  - Regression: the full existing suite passes unchanged with the flag off (proves the refactor is behavior-preserving across all ~12 migrated sites).
  - Connection-pool leak: after a flag-on `withTenant` call returns its client to the pool, a subsequent `withClient` checkout is NOT still in `rls_app_runtime` (role reset on release) — pin in the integration test (U4).
- **Verification:** with flag off, byte-for-byte today's behavior + green suite; with flag on (in test), every tenant-scoped path runs as the role.

### U4. Enforcement integration test (the proof)
- **Goal:** Prove R1–R4 against real Postgres with the role active (mocked DB cannot prove RLS).
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** U1, U2, U3
- **Files:** `packages/api/test/integration/rls-runtime-role.test.ts`.
- **Approach:** Use the `EXTERNAL_TEST_DB_URL` harness (see `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`). Seed two tenants with data, then with the runtime role active assert isolation; also run a representative write/read slice to prove no missing grant; and assert the privileged sweep path still sees all tenants.
- **Patterns to follow:** the integration harness `getSharedTestDb`/`createTestTenant`; the spike SQL in this session (validated the exact assertions).
- **Test scenarios:**
  - R1: GUC=tenant B, `SELECT * FROM customers WHERE id=<A>` (no tenant filter) → 0 rows; cross-tenant UPDATE/INSERT blocked, across `customers/jobs/estimates/invoices/appointments` and the two U2 tables.
  - R2: unset GUC under the role → 0 rows / error.
  - R3: a lead-to-cash repo read + a write succeed under the role (no permission error); spot-check a worker/digest/analytics query path.
  - R4: `withClient`-based `findReadyForExecution` (or a representative cross-tenant query) still returns rows across tenants.
  - Public path: `find_estimate_by_view_token` still returns its row under the restricted session (SECURITY DEFINER runs as owner).
  - Pool hygiene: role does not leak to a subsequent privileged checkout.
- **Verification:** all assertions green with the role active; isolation holds even with a deliberately tenant-filter-less query.

### U5. Rollout runbook + ops gate
- **Goal:** Give ops a safe, reversible path to enable enforcement in prod, including the prod-principal
  capability check that could not be verified from dev (R5).
- **Requirements:** R5
- **Dependencies:** U1, U3
- **Files:** `docs/runbooks/rls-runtime-role-rollout.md` (new).
- **Approach:** Document: (1) confirm the prod DB principal can `CREATE ROLE`+`GRANT` (or have infra
  pre-provision `rls_app_runtime` + membership); (2) deploy with `RLS_RUNTIME_ROLE` unset (migration
  provisions the role, no behavior change); (3) in staging, set `RLS_RUNTIME_ROLE=true`, verify boot +
  smoke the lead-to-cash flow; (4) enable in prod; (5) rollback = unset the flag (instant, no migration).
- **Test scenarios:** `Test expectation: none — operational runbook.`
- **Verification:** an operator can follow it end-to-end; the prod-principal question is explicitly answered before enabling.

## Risks & Dependencies
- **Missing-grant 500 in prod (R3).** Mitigated by `GRANT … ON ALL TABLES` + default privileges + the U4
  regression slice, but full coverage of every query path isn't guaranteed — hence staged rollout (U5)
  and the instant flag-off rollback.
- **Connection-pool role leak.** The non-transactional `withTenant` path uses session-level `SET ROLE`;
  failing to `RESET ROLE` before release would poison the next checkout (a privileged sweep would run as
  the restricted role). The existing code already has this exact hazard for the GUC and handles it; U3
  must extend the same discipline to the role, pinned by the U4 pool-hygiene test.
- **Prod principal lacks `CREATEROLE`.** The migration degrades gracefully (U1); U5 makes provisioning an
  explicit ops step. Enforcement simply stays off until the role exists.
- **Migration numbering / immutability snapshot:** U1 + U2 add migrations (next numbers after the current
  head); both need snapshot entries or the immutability test fails; watch for collisions on merge.

## Open Questions (deferred to implementation)
- `platform_deprovision_log`: tenant-scoped policy vs documented `withClient`-only exemption — decide from
  its actual access paths (U2).
- The session vs `SET LOCAL ROLE` choice on the non-transactional `withTenant` path, and whether to
  convert that path to a transaction so role/GUC auto-reset (simpler, but changes connection semantics).
- Whether to simulate the `insufficient_privilege` degrade path in CI (needs a non-CREATEROLE test role).

## Sources & Research
- **Spike (this session), validated against real Postgres:** `customers` is FORCE-RLS; under
  `rls_app_runtime` with GUC=tenant A → only A's row, `A_sees_B=0`; unset GUC → error (fails closed);
  a normal same-tenant INSERT succeeds under the role. The connection role `postgres` is
  `rolsuper=t, rolbypassrls=t` (RLS inert today).
- **RLS coverage measured:** 104 tenant tables, **102 RLS-enabled, 2 not** (`oauth_states`,
  `platform_deprovision_log`); every RLS-enabled table has a policy (no default-deny surprises).
- **Seam blast radius:** ~12 `setTenantContext` call sites + the `set_config` request middleware.
- `docs/verification-runs/beta-verification-2026-06-25.md` (finding #5);
  `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md` (integration-test harness).
