# Phase 1 — Core Business Entities: Launch Readiness Gaps

> **5 stories** | Continues from P1-017

---

## Purpose

Once Postgres repositories exist (Phase 0 gaps), verify the entity layer works end-to-end with real persistence: search, deduplication, settings, and tenant isolation.

## Exit Criteria

All entities searchable and filterable against Postgres; duplicate prevention enforced at database level; settings page saves and loads real data; RLS tenant isolation verified with integration tests.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P1-018 | Postgres-backed search, pagination, and filtering for list endpoints | S | API | High | Moderate | P0-023 |
| P1-019 | Customer and location deduplication against Postgres | S | Validation | Medium | Heavy | P0-019, P1-004 |
| P1-020 | Settings page backend wiring — business profile save | S | Settings/UI | High | Moderate | P0-022, P0-029 |
| P1-021 | Team management in settings — add, remove, assign roles | S | Settings/UI | Medium | Heavy | P0-022, P0-029, P0-003 |

---

## Story Specifications

### P1-018 — Postgres-backed search, pagination, and filtering for list endpoints

> **Size:** S | **Layer:** API | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-023

**Allowed files:** `packages/api/src/routes/**, packages/api/src/customers/**, packages/api/src/jobs/**, packages/api/src/estimates/**, packages/api/src/invoices/**`

**Build prompt:** Update all list endpoints to support real Postgres-backed search, pagination, and filtering. Currently list queries use InMemory array filtering — replace with SQL `WHERE` clauses, `ILIKE` for text search, `LIMIT`/`OFFSET` for pagination, and `ORDER BY` for sorting. Endpoints to update: customers (search by name/phone/email), jobs (filter by status/customer/technician), estimates (filter by status/customer), invoices (filter by status/customer/due date), appointments (filter by date range/technician). Return `{ data: T[], total: number }` to support frontend pagination.

**Review prompt:** Verify all search queries use parameterized `ILIKE` (not string concatenation). Verify pagination uses `OFFSET`/`LIMIT` with total count. Verify sorting defaults are sensible (newest first for most entities). Check query performance with indexes on commonly filtered columns. Verify all filters include tenant_id.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-018"
```

**Required tests:**
- [ ] Search — partial name match returns correct customers
- [ ] Pagination — page 2 returns next set, total count is accurate
- [ ] Filter — status filter returns only matching records
- [ ] Combined — search + filter + pagination work together
- [ ] Empty results — returns `{ data: [], total: 0 }`, not error
- [ ] SQL injection — special characters in search term don't break query

---

### P1-019 — Customer and location deduplication against Postgres

> **Size:** S | **Layer:** Validation | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-019, P1-004

**Allowed files:** `packages/api/src/customers/**, packages/api/src/locations/**`

**Build prompt:** The existing `dedup.ts` files for customers and locations implement deduplication against InMemory data. Update them to query Postgres instead. Customer dedup should check for existing records with matching (normalized phone OR normalized email) within the same tenant. Location dedup should check for matching (street1 + city + state + postalCode) within the same customer. Return potential matches with a confidence score. Do not block creation — return warnings that the frontend can display. Use database indexes for efficient dedup lookups.

**Review prompt:** Verify dedup queries are indexed (composite index on tenant_id + normalized_phone, tenant_id + normalized_email). Verify normalization is consistent (phone stripped to digits, email lowercased). Verify dedup is advisory (warnings, not blocks). Check performance with large customer lists (1000+ per tenant).

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-019"
```

**Required tests:**
- [ ] Phone match — normalized phone finds existing customer
- [ ] Email match — case-insensitive email finds existing customer
- [ ] Address match — same address on same customer found
- [ ] No match — new unique customer returns no warnings
- [ ] Cross-tenant — same phone on different tenant is NOT a match
- [ ] Multiple matches — returns all potential duplicates

---

### P1-020 — Settings page backend wiring — business profile save

> **Size:** S | **Layer:** Settings/UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-022, P0-029

**Allowed files:** `packages/web/src/components/settings/**, packages/api/src/routes/settings.ts`

**Build prompt:** Replace the stub `action: () => {}` handlers in SettingsPage.tsx for the Business Profile section. Wire the form to call `PATCH /api/settings` with the updated fields: businessName, phone, address, timezone, estimatePrefix, invoicePrefix, defaultPaymentTermDays. Load current settings on mount via `GET /api/settings`. Show loading state while fetching. Show success/error toast on save. The backend route handler already exists — verify it persists to the Postgres settings repository.

**Review prompt:** Verify all empty `action: () => {}` handlers for business profile are replaced with real API calls. Verify loading state while fetching settings. Verify validation (timezone must be valid, prefixes must be non-empty). Verify toast feedback on save success/failure.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-020"
```

**Required tests:**
- [ ] Happy path — settings load on mount, save persists
- [ ] Validation — invalid timezone rejected
- [ ] Toast — success toast on save, error toast on failure
- [ ] Optimistic update — UI updates immediately, rolls back on error

---

### P1-021 — Team management in settings — add, remove, assign roles

> **Size:** S | **Layer:** Settings/UI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-022, P0-029, P0-003

**Allowed files:** `packages/web/src/components/settings/**, packages/api/src/routes/settings.ts, packages/api/src/auth/**`

**Build prompt:** Wire the Team Management section of SettingsPage. Implement: (1) List team members for the current tenant via `GET /api/settings/team`. (2) Invite a new team member by email with a role assignment via `POST /api/settings/team/invite`. (3) Change a team member's role via `PATCH /api/settings/team/:userId/role`. (4) Remove a team member via `DELETE /api/settings/team/:userId`. Only owners can manage team. Use Clerk's invitation API for email invites. Show role badges (owner, dispatcher, technician) for each member.

**Review prompt:** Verify only owners can access team management (RBAC check). Verify Clerk invitation API is called for new invites. Verify role changes are persisted to both local DB and Clerk metadata. Verify an owner cannot remove themselves. Verify removed users lose access immediately.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P1-021"
```

**Required tests:**
- [ ] Happy path — list team members
- [ ] Invite — new member invited with role
- [ ] Role change — dispatcher promoted to owner
- [ ] Remove — team member removed, loses access
- [ ] Self-removal blocked — owner cannot remove themselves
- [ ] Permission — non-owner gets 403 on team management

---

### P1-022 — Add `mobile_number` to users for inbound identity binding

> **Size:** S | **Layer:** Data | **AI Build:** High | **Human Review:** Moderate | **Wave:** Wave-C blocker B4

**Dependencies:** P0-019, P1-008

**Allowed files:** `packages/api/src/db/schema.ts`, `packages/api/src/users/user.ts`, `packages/api/src/users/pg-user.ts`, `packages/api/src/shared/phone/normalize.ts` (new — colocate E.164 normalization)

**Build prompt:** The `users` table has no mobile-number column today. Two upcoming stories need to bind an inbound communication to a user by mobile: P6-028 (tech replies `OUT` from their phone) and P8-016 (system patches an emergency call through to the owner's cell). Add migration key `109_users_mobile_number` to `packages/api/src/db/schema.ts`'s `MIGRATIONS` object: `ALTER TABLE users ADD COLUMN mobile_number TEXT;` and `CREATE UNIQUE INDEX users_mobile_unique ON users (tenant_id, mobile_number) WHERE mobile_number IS NOT NULL;` — partial unique so existing rows (NULL) don't conflict. Extend the `User` interface in `packages/api/src/users/user.ts` with `mobileNumber?: string`. Extend `pg-user.ts` to read/write the column and add `findByMobileNumber(tenantId: string, e164: string): Promise<User | null>`. Add an E.164 normalization helper at `packages/api/src/shared/phone/normalize.ts` so callers store and look up consistently — accept common US input formats and reject obviously bad ones with a clear error.

**Review prompt:** Verify the migration is idempotent (uses `IF NOT EXISTS` patterns where possible — note that ALTER TABLE ADD COLUMN already requires `IF NOT EXISTS` post-9.6). Verify the partial unique index allows multiple NULLs but rejects two rows sharing a `(tenant_id, mobile_number)` pair. Verify the normalizer handles `(555) 123-4567` → `+15551234567` and rejects `abc`. Verify `findByMobileNumber` does NOT leak cross-tenant rows (defense-in-depth alongside RLS). Confirm no caller bypasses the normalizer to store raw input.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P1-022"
```

**Required tests:**
- [ ] Add mobile to a user, look it up by E.164
- [ ] Two users in the same tenant cannot share a mobile (uniqueness)
- [ ] Two users in different tenants CAN share a mobile (partial unique scoped by tenant)
- [ ] Multiple users with NULL mobile in same tenant (partial index permits this)
- [ ] Normalizer: `(555) 123-4567`, `555-123-4567`, `5551234567` all → `+15551234567`
- [ ] Normalizer rejects `abc` and `+1234` (too short)
- [ ] `findByMobileNumber` returns `null` for cross-tenant lookups
