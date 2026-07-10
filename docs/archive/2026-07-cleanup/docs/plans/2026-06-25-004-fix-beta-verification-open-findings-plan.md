# fix: Resolve open beta-verification findings (dispatch names, technician-id consistency, RLS defense-in-depth, runbook accuracy)

**Created:** 2026-06-25
**Depth:** Deep
**Status:** plan

> **Scope assumption (please confirm):** "the Cristal bugs" was not resolvable
> from the codebase (no `cristal`/`crystal` feature exists). I'm planning against
> the **open findings from today's beta-verification run**
> (`docs/verification-runs/beta-verification-2026-06-25.md`) — i.e. the bugs that
> run *documented but did not fix*. The three blocking schema bugs from that run
> (#1 `claimed_by`, #2 `interactions` 500, #3 `delay_notice_state`) are **already
> fixed and pushed** (commit `0c5572a1`) and are explicit non-goals here. If
> "Cristal" means something else (a tenant, a GitHub issue), stop and redirect.

## Summary
Close the four remaining findings from the 2026-06-25 beta-verification run:
(U1) the dispatch board renders raw technician UUIDs instead of names; (U2) the
runbook's RBAC/route expectations are stale vs the code; (U3) the technician
location-ping subsystem identifies technicians by Clerk id while the rest of
scheduling uses `users.id` (UUID), so dispatchers can't submit pings for a tech;
and (U4) the application connects to Postgres as an RLS-bypassing role, so
Row-Level Security provides **zero** runtime defense-in-depth — tenant isolation
currently rests entirely on application-layer `tenant_id` filters.

## Problem Frame
These surfaced when every runbook workflow was driven against the real API + DB.
None leak data today, but each is a latent correctness/safety gap: U4 means one
forgotten `WHERE tenant_id =` clause anywhere would silently cross tenants; U3
breaks the dispatcher "submit location for tech X" path; U1 is a visible UX
defect on the board; U2 makes the runbook untrustworthy for the next sign-off.

## Requirements
- R1. The dispatch board shows each technician's display name (falling back to a
  stable label, never a bare UUID) for both lanes and assignment cards.
- R2. `docs/beta-verification-runbook.md` §17.18–17.24 match the code's actual
  RBAC matrix and the routes that actually exist.
- R3. A dispatcher/owner can submit a location ping for a technician using the
  **same** technician identifier the rest of scheduling uses (`users.id`), and
  the technician self-submit path keeps working; cross-actor submits stay authz-gated.
- R4. With the app connected as a non-superuser runtime role, RLS blocks
  cross-tenant reads/writes at the DB layer (GUC set → only that tenant's rows;
  GUC unset → zero rows / error), while every existing app query still succeeds.

## Key Technical Decisions
- **U3 — standardize the technician identifier on `users.id` (UUID), not the Clerk id.**
  `appointment_assignments.technician_id`, `appointments.assigned_technician_id`,
  and the board all reference `users(id)` (UUID); only the location-ping path uses
  the Clerk id (`technician_location_pings.technician_id` is `TEXT`, and the route
  forces it to equal `auth.userId`). Aligning the ping path to `users.id` makes one
  canonical technician identity. *Alternative considered:* make the authz query
  tolerant (`WHERE id::text = $2 OR clerk_user_id = $2`) — rejected as a lower-risk
  band-aid that leaves two identifier conventions in the schema and would re-confuse
  the next reader. The defensive variant is the documented fallback if the column
  backfill (below) proves too risky for prod data.
- **U4 — enforce RLS via a least-privilege runtime role the app `SET LOCAL ROLE`s into**
  inside the existing tenant-scoped client setup, rather than changing the
  `DATABASE_URL` principal. Keeping the connection principal (which must retain
  `CREATEROLE`/migrate rights and own the `SECURITY DEFINER` view-token functions)
  and dropping privilege per-transaction is reversible and confines blast radius to
  the GUC seam already in `pg-base.ts`. *Alternative considered:* point
  `DATABASE_URL` at a restricted role — rejected because the same connection runs
  migrations and owns the view-token functions; a global swap risks boot/migrate
  failures and is hard to roll back on Railway.
- **U4 is high-risk and prod-infra-dependent** — it gets a spike sub-step before the
  code change (confirm the Railway/prod DB principal can `CREATE ROLE` + `GRANT`
  membership, and that `SET LOCAL ROLE` is permitted). If the spike fails, U4 splits
  into its own infra plan and does not block U1–U3.

## Scope Boundaries
**In scope:** the four open findings (U1–U4) on the canonical product under `/packages` + the runbook doc.
**Non-goals:**
- The three already-fixed/pushed schema bugs (#1 `claimed_by`, #2 `interactions`, #3 `delay_notice_state`).
- Exercising external-provider legs (Stripe/Twilio/Clerk live) — needs staging, not code.
- Any UI redesign of the dispatch board beyond rendering the resolved name.
### Deferred to follow-up work
- Surfacing dispatch analytics via a read endpoint (write-only table noted in the run) — not a bug.
- Broader audit of every repo query for a missing `tenant_id` filter (U4 makes RLS the backstop; a full sweep is separate).

## Repository invariants touched
- **RLS / `tenant_id`:** U4 is the core RLS-enforcement change; U3's migration must
  carry the existing `tenant_isolation_*` policy + `tenant_id` semantics on
  `technician_location_pings`. Both must preserve `FORCE ROW LEVEL SECURITY` where present.
- **Audit events:** no new mutations of business entities; the location-ping path is
  telemetry (no audit event today, unchanged). If U3 adds a role/identity change path, no audit needed.
- **Human-approval gate / LLM gateway / catalog & entity resolvers / integer cents:** untouched.

## High-Level Technical Design
U4 changes only the tenant-scoped client seam. Today `withTenant` /
`withTenantTransaction` (`packages/api/src/db/pg-base.ts`) do
`SET LOCAL app.current_tenant_id = <tenant>` on a checked-out client. The change
adds `SET LOCAL ROLE rls_app_runtime` in the same place, so every tenant-scoped
query runs as the RLS-subject role with the GUC set; the connection principal
(superuser/owner) still runs migrations and the `SECURITY DEFINER` view-token
functions for public pages. RESET on release already exists for the GUC and must
also reset the role.

## Implementation Units

### U1. Wire technician display names into the dispatch board
- **Goal:** Replace raw technician UUIDs on the board with display names (R1).
- **Requirements:** R1
- **Dependencies:** none
- **Files:**
  - `packages/api/src/dispatch/routes.ts` (board GET handler that calls `getDispatchBoardData`) — populate the `getTechnicianName` resolver.
  - `packages/api/src/dispatch/board-query.ts` (already exposes `getTechnicianName?` + `techNameMap` with `?? technicianId` fallback) — no signature change expected; confirm the fallback path.
  - `packages/api/src/users/pg-user.ts` — source of `id → display name` (batch lookup for the board's technician ids).
  - Test: `packages/api/test/dispatch/board-query.test.ts` (extend if present, else create).
- **Approach:** In the board route, collect the distinct technician ids on the
  board, batch-resolve them to display names via the user repo (tenant-scoped),
  and pass a `getTechnicianName`/`techNameMap` into `getDispatchBoardData`. Keep
  the `?? technicianId` fallback for ids with no user row (deactivated/unknown).
- **Patterns to follow:** the existing `techNameMap` resolution in `board-query.ts:249`; tenant-scoped repo reads elsewhere in `src/dispatch`.
- **Test scenarios:**
  - Happy path: board with 2 assigned technicians → both lanes/cards show display names, not UUIDs.
  - Edge: a technician id with no matching `users` row → falls back to the id (no crash, no blank).
  - Edge: unassigned-queue items carry no technician → no resolver call, no error.
- **Verification:** `GET /api/dispatch/board` returns `technicianName` = the user's display name for assigned techs; raw UUID appears only for unknown ids.

### U2. Correct stale runbook RBAC/route expectations
- **Goal:** Make `docs/beta-verification-runbook.md` match the code (R2).
- **Requirements:** R2
- **Dependencies:** none
- **Files:** `docs/beta-verification-runbook.md` (§17.18, §17.19, §17.23, §17.24).
- **Approach:** §17.18/§17.19 — technicians do **not** hold `estimates:view`/`invoices:view`; change expected results to **403** and cite `packages/api/src/auth/rbac.ts`. §17.23/§17.24 — jobs expose `PUT /:id` + `POST /:id/transition` (no `PATCH`/`DELETE`); rewrite to the real verbs (tech status update via `/transition` → 200; tech cannot delete because no route + no `jobs:delete`).
- **Patterns to follow:** the RBAC matrix in `packages/api/src/auth/rbac.ts`; the job routes in `packages/api/src/routes/jobs.ts`.
- **Test scenarios:** `Test expectation: none — documentation correction` (the RBAC behavior itself is already covered by §17 verification + rbac unit tests).
- **Verification:** the runbook's §17 expectations match what the API actually returns; a future run won't flag false failures.

### U3. Standardize the technician location-ping identifier on `users.id`
- **Goal:** One canonical technician id across scheduling so dispatchers/owners can submit pings for a tech (R3).
- **Requirements:** R3
- **Dependencies:** none (independent of U1/U4)
- **Files:**
  - `packages/api/src/db/schema.ts` — new migration: `technician_location_pings.technician_id` `TEXT` → `UUID` with FK to `users(id)`, **backfilling** existing values by mapping the stored Clerk id → `users.id` (join `users.clerk_user_id`); rows with no match must be handled (see Open Questions). Preserve the table's RLS policy.
  - `packages/api/test/db/migration-immutability.test.ts` — add the new migration's snapshot hash (regen via the documented method).
  - `packages/api/src/routes/technician-location.ts` — change the technician self-check (line ~47) from `parsed.technicianId !== req.auth.userId` to compare against the caller's `users.id` (resolve `auth.userId` Clerk id → `users.id`, or accept the user's id directly per the new contract).
  - `packages/api/src/telemetry/technician-location-authz.ts` — change the Pg authz query from `WHERE clerk_user_id = $2` to `WHERE id = $2` (match `users.id`); keep the in-memory authorizer semantics aligned.
  - `packages/api/src/telemetry/pg-technician-location-ping.ts` — ensure writes/reads use the UUID id.
  - Tests: `packages/api/test/integration/technician-location-authz.test.ts` (new, Docker/EXTERNAL_TEST_DB_URL-gated) + a unit test for the route self-check.
- **Approach:** Make `technicianId` mean `users.id` everywhere on this path. The
  migration is the risky part (existing TEXT values are Clerk ids, not castable to
  UUID — they must be backfilled via the `users` join, not a blind `::uuid` cast).
- **Patterns to follow:** migration conventions + RLS policy block in `schema.ts`
  (e.g. `196_create_device_tokens`); the integration-test harness in
  `packages/api/test/integration/` (`getSharedTestDb`/`createTestTenant`).
- **Test scenarios:**
  - Happy path: owner submits a ping with a tech's `users.id` → authorized, row stored under that uuid.
  - Happy path: technician self-submits (their own `users.id`) → authorized.
  - Error path: non-self technician id by a technician role → 403; unknown id by owner → 403 (no matching user).
  - Migration/integration (real Postgres): pre-seed a ping with a Clerk-id value + a matching user → after migration the row's `technician_id` equals that user's `users.id`; FK holds; a no-match legacy row is handled per the resolved Open Question.
- **Verification:** a dispatcher using the id shown on the board can submit a tech's location ping (200), and the column is a UUID FK to `users(id)` with no orphan rows.

### U4. Enforce RLS at the DB layer via a least-privilege runtime role
- **Goal:** Make RLS a real runtime backstop, not a no-op (R4).
- **Requirements:** R4
- **Dependencies:** none functionally, but **sequence last** (highest risk); gated by the spike below.
- **Files:**
  - *(spike, no code)* confirm the prod/Railway DB principal can `CREATE ROLE` + `GRANT` membership and that `SET LOCAL ROLE` is permitted; record findings in this plan / a `docs/solutions/` note.
  - `packages/api/src/db/schema.ts` — new migration: `CREATE ROLE rls_app_runtime NOLOGIN` (RLS-subject: **not** `BYPASSRLS`, **not** table owner), `GRANT` the needed table privileges (SELECT/INSERT/UPDATE/DELETE on tenant tables, USAGE on sequences), and `GRANT rls_app_runtime TO <app principal>`. Idempotent (`DO $$ ... IF NOT EXISTS`).
  - `packages/api/test/db/migration-immutability.test.ts` — snapshot the new migration.
  - `packages/api/src/db/pg-base.ts` — in `withTenant`/`withTenantTransaction`, add `SET LOCAL ROLE rls_app_runtime` alongside the existing `SET LOCAL app.current_tenant_id`; ensure role is reset on release (mirror the existing `RESET app.current_tenant_id`).
  - Tests: `packages/api/test/integration/rls-runtime-role.test.ts` (new, Docker/EXTERNAL_TEST_DB_URL-gated).
- **Approach:** Drop privilege per tenant-scoped transaction at the one seam that
  already sets the tenant GUC. The connection principal stays privileged for
  migrations + the `SECURITY DEFINER` view-token functions (migration 119), which
  run as owner and remain unaffected for public estimate/invoice pages.
- **Patterns to follow:** the GUC set/reset lifecycle already in `pg-base.ts`; the
  RLS policy authorship in `schema.ts`; the run's finding #5 in
  `docs/verification-runs/beta-verification-2026-06-25.md`.
- **Test scenarios:**
  - Security (real Postgres, connected/`SET ROLE` as `rls_app_runtime`): GUC = tenant B, query tenant A's `customers/jobs/estimates/invoices/appointments` → **0 rows** each; GUC unset → **0 rows / error** (fails closed).
  - Regression (real Postgres): a representative slice of normal app queries (a lead-to-cash repo read + a write) succeed under the runtime role with the GUC set — proves no missing GRANT.
  - Public-page path: the `find_*_by_view_token` `SECURITY DEFINER` functions still return rows under the restricted role (owner-executed) → public estimate/invoice pages unaffected.
- **Verification:** with the app on the runtime role, cross-tenant DB access returns
  zero rows even when the app-layer filter is bypassed, and the full app test suite
  + a manual lead-to-cash drive still pass.

## Risks & Dependencies
- **U4 is the dominant risk.** A missing `GRANT` surfaces only at runtime as a
  permission error on some query path; mitigation = the regression integration test
  exercising real query paths under the role, plus a staged rollout. If the prod
  principal lacks `CREATEROLE`/`GRANT` rights, U4 becomes an infra ticket — it must
  not block U1–U3. Strongly consider shipping U4 on its own PR after U1–U3.
- **U3 migration** can't blind-cast Clerk-id strings to UUID; the backfill join is
  mandatory and legacy no-match rows need an explicit policy (Open Questions).
- **Migration numbering / immutability snapshot:** U3 and U4 each add a migration
  (next numbers after `216`); both need snapshot entries or the immutability unit
  test fails. Watch for number collisions on merge with `main`.

## Open Questions (deferred to implementation)
- U3: how to treat existing `technician_location_pings` rows whose Clerk-id value
  has no matching `users.clerk_user_id` (delete telemetry-only orphans, or keep as
  NULL technician?). Resolve against real prod-shaped data at implementation time.
- U4: exact privilege set `rls_app_runtime` needs (precise table/sequence GRANT
  list) — derive empirically from the regression test, not guessed up front.
- U4: whether Railway's DB principal can `CREATE ROLE`/`GRANT` (the spike answers this).

## Sources & Research
- `docs/verification-runs/beta-verification-2026-06-25.md` — findings #4 (technician-id), #5 (RLS role), #6 (board name), and the runbook-staleness notes (the source of all four units).
- Code: `src/routes/technician-location.ts:47` (Clerk-id self-check), `src/telemetry/technician-location-authz.ts` (authz query), `src/db/schema.ts` (`appointment_assignments.technician_id UUID REFERENCES users(id)`; no `rls_app_runtime` role in any migration), `src/db/pg-base.ts` (GUC seam), `src/dispatch/board-query.ts` (`getTechnicianName` hook + `?? technicianId` fallback).
