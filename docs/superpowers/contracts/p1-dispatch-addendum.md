# Phase 1 (Operations) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-1-gap-stories.md` with dispatch metadata for the four operational gap stories.

For every story, the agent prompt should include:
- The full body of the story from `phase-1-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 1A-ops | P1-018, P1-019 | parallel (2 agents) | none — both touch different repos and tests |
| 1B-ops | P1-020, P1-021 | parallel (2 agents) — settings-page work | none |

P1-018 has the highest dispatcher-UX impact (list navigation at scale); ship first regardless of order.

---

## P1-018 — Postgres-backed search, pagination, filtering for list endpoints

**Wave:** 1A-ops
**Migration number reserved:** `054_*` (only if indexes are added; the story is index-friendly but new indexes are optional — surface a recommendation if any existing list query is slow without them)
**Forbidden files:**
- `packages/api/src/db/schema.ts` (only touch via the reserved migration if absolutely needed; otherwise skip)
- `packages/api/src/db/pg-base.ts` (Tier 1 locked)
- `packages/api/src/auth/**`
- `packages/shared/**`
- `packages/api/src/app.ts` (no app-wiring changes)

**Allowed files (concrete list):**
- `packages/api/src/routes/customers.ts` (modify — accept `?search` `?limit` `?offset` `?sort` query params)
- `packages/api/src/routes/jobs.ts` (modify)
- `packages/api/src/routes/invoices.ts` (modify)
- `packages/api/src/routes/estimates.ts` (modify)
- `packages/api/src/routes/appointments.ts` (modify)
- `packages/api/src/customers/customer.ts` + `pg-customer.ts` (modify list / search method to accept ListOptions)
- `packages/api/src/jobs/job.ts` + `pg-job.ts` (same)
- `packages/api/src/invoices/invoice.ts` + `pg-invoice.ts` (same)
- `packages/api/src/estimates/estimate.ts` + `pg-estimate.ts` (same)
- `packages/api/src/appointments/appointment.ts` + `pg-appointment.ts` (same)
- `packages/api/test/routes/*.route.test.ts` (modify)
- `packages/api/test/customers/`, `packages/api/test/jobs/`, etc (modify pg-* tests)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "P1-018|search|pagination|listCustomers|listJobs|listInvoices|listEstimates|listAppointments"
```

**Pre-flight:** P0-023 merged ✓ (verified earlier). The new Pg repos (P0-019, P0-020, P0-021, P0-022) are wired in `app.ts`.

**Risk note:**
- **`tenant_id` first.** Every WHERE clause MUST include `tenant_id = $N` BEFORE any other filter — even though RLS would enforce it, defense-in-depth is the convention (per `repository-conventions.md`).
- **Parameterized `ILIKE`.** Search uses `ILIKE` with `%search%` — interpolate via `$N` parameter binding, NEVER string concatenation. SQL injection here would be tenant-crossing.
- **Total-count cost.** Returning `{ data, total }` requires a second query (`SELECT COUNT(*)` with the same WHERE). For tenants with millions of rows, that's expensive. v1 OK; consider a `pg_stat_*` estimate for v2.
- **Sorting.** Default `ORDER BY created_at DESC` for jobs/estimates/invoices; `ORDER BY name ASC` for customers. Document in each list method.
- **Limit cap.** Cap `?limit` at 200 server-side; reject `limit > 200` with 400. Default 50 if missing.
- **Offset performance.** Deep `OFFSET` is slow on large tables; v1 fine, v2 should switch to keyset pagination. Surface this as a follow-up note in the PR description.
- **Existing list contract may differ.** Some routes already accept partial filters (e.g. `customers` already takes `?search`). Read each route first — extend, don't replace.

---

## P1-019 — Customer and location deduplication against Postgres

**Wave:** 1A-ops
**Migration number reserved:** none (the dedup function already exists at `customers/dedup.ts:22-79`; the missing piece is calling it from `createCustomer`)
**Forbidden files:**
- `packages/api/src/customers/dedup.ts` (do NOT modify the dedup logic itself; it's already well-tested)
- `packages/shared/**`
- `packages/api/src/db/schema.ts`

**Allowed files (concrete list):**
- `packages/api/src/customers/customer.ts` (modify — call `checkCustomerDuplicates` in `createCustomer`)
- `packages/api/src/locations/location.ts` (similar — if the location domain has a dedup function, wire it)
- `packages/api/test/customers/customer.test.ts` (modify — add dedup-on-create tests)
- `packages/api/test/locations/location.test.ts` (similar)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "P1-019|dedup|createCustomer.*duplicate|checkCustomerDuplicates"
```

**Pre-flight:** P0-019 merged ✓ (PgCustomer wired).

**Risk note:**
- **Behavior on duplicate detection** is the design call. Options: (a) hard-reject with a 409 + the matching customer's id, (b) soft-warn + allow (return matches alongside the new customer for the dispatcher to merge), (c) auto-merge into the existing customer. v1: **(a) hard-reject + return match**. UI can offer "merge" later.
- **Phone/email normalization.** `1 (415) 555-1234`, `415-555-1234`, `+14155551234` should all match. The existing dedup function MAY already normalize — verify; don't duplicate the logic.

---

## P1-020 — Settings page backend wiring — business profile save

**Wave:** 1B-ops
**Status:** Per the prior phase-status audit, P1-020 was **DONE** at the time. Re-verify before dispatch — the `routes/settings.ts:47-93` PUT endpoint may already cover this. If yes, this story collapses to a small UI-wiring follow-up; surface that in the dispatch.

**Allowed files (concrete list, if work remains):**
- `packages/api/src/routes/settings.ts` (modify if endpoint missing fields)
- `packages/web/src/components/settings/SettingsPage.tsx` (modify — wire form to PUT)
- corresponding tests

**Pre-flight:** P0-022 (settings repo Pg) merged ✓; P0-029 (frontend Clerk) merged ✓.

---

## P1-021 — Team management in settings — add, remove, assign roles

**Wave:** 1B-ops
**Status:** Per the audit, P1-021 was **NOT STARTED** — no `routes/team.ts` or `routes/users.ts` for tenant user management.

**Allowed files (concrete list):**
- `packages/api/src/routes/team.ts` (new)
- `packages/api/src/users/user-service.ts` (new — invite, remove, change-role helpers backed by Clerk org / tenant users table)
- `packages/api/src/users/user.ts` (extend if needed)
- `packages/api/test/routes/team.route.test.ts` (new)
- `packages/api/test/users/user-service.test.ts` (new)
- `packages/web/src/components/settings/TeamSettings.tsx` (new)
- `packages/web/src/components/settings/SettingsPage.tsx` (modify — add team tab)

**Pre-flight:** P0-003 (Clerk org/auth groundwork) merged ✓; P0-022 settings ✓; P0-029 frontend Clerk ✓.

**Risk note:**
- **Clerk org boundary.** If Clerk Organizations are the source-of-truth for tenant membership, the API should mirror Clerk's invitation flow. Otherwise, the API maintains its own `tenant_users` table that the Clerk webhook populates.
- **Role enforcement.** Adding/removing a user requires `requirePermission('settings:manage_team')`. Adding the permission to `auth/rbac.ts` is allowed since `rbac.ts` is Tier 1 locked for **renaming** but additive permission entries are permitted.

---

## P1-022 — Add `mobile_number` to users for inbound identity binding

**Wave:** Wave-C blocker B4 (see `docs/superpowers/plans/2026-05-17-wave-c-bad-day-recovery.md`)
**Migration number reserved:** `109_users_mobile_number` (was `101`; bumped — main advanced to migration 108, and `101` is now `101_google_reviews`)
**Forbidden files:**
- `packages/api/src/sms/tech-status/**` (P6-028 consumes — does not modify users)
- `packages/api/src/voice/triage/**` (P8-016 consumes for owner-cell paging)
- `packages/api/src/auth/**` (no auth-system changes — this is a data field)
- `packages/shared/**`

**Allowed files (concrete list):**
- `packages/api/src/db/schema.ts` (modify — add key `109_users_mobile_number`)
- `packages/api/src/users/user.ts` (modify — add `mobileNumber?: string`)
- `packages/api/src/users/pg-user.ts` (modify — read/write column + `findByMobileNumber()`)
- `packages/api/src/users/pg-user.test.ts` (modify — add coverage)
- `packages/api/src/shared/phone/normalize.ts` (new)
- `packages/api/src/shared/phone/normalize.test.ts` (new)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "P1-022|mobile_number|findByMobileNumber|normalize"
```

**Pre-flight:** none.

**Risk note:**
- **Partial unique index allows multiple NULLs.** This is the desired behavior — users without a mobile shouldn't conflict with each other. Verify the index syntax compiles in Postgres 14+ and the migration is replayable.
- **Tenant-scoped uniqueness.** Two users in different tenants CAN share a mobile (e.g., a human registered in two ServiceOS tenants).
- **E.164 storage.** The column stores normalized E.164 (`+15551234567`). Callers pass raw input through `normalize()` before storage and before lookup.
- **Defense-in-depth.** `findByMobileNumber(tenantId, e164)` always filters by `tenant_id` in the WHERE clause, not just relying on RLS.

**Implementation hints:**
1. Read the existing `pg-user.ts` first to see column-read/write patterns and the snake_case/camelCase mapping helper in `pg-base.ts`.
2. The `normalize` helper covers common US formats: `(555) 123-4567`, `555-123-4567`, `555.123.4567`, `5551234567`, `+1-555-123-4567`. Reject obviously bad input (too short, contains letters) with a typed error.
3. **Migration body** (final form):
   ```sql
   ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number TEXT;
   CREATE UNIQUE INDEX IF NOT EXISTS users_mobile_unique
     ON users (tenant_id, mobile_number)
     WHERE mobile_number IS NOT NULL;
   ```
4. RLS on `users` already exists (verify in `schema.ts`); no new policy needed.

---

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md` § Universal pre-flight checks. Apply to every Phase 1 story before launching the dispatch agent.
