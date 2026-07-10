# Phase 20 — CRM Parity Net-New: Memberships + Live Booking

> **2 stories** | The two competitor-parity gaps with NO existing home in the roadmap (Phases 9–16 cover the rest). Sourced from the Jobber / ServiceTitan / ServiceNow CRM gap analysis (2026-05-25).

---

## Purpose

The CRM gap analysis found that ServiceOS already builds or specs nearly every
service-CRM feature in Jobber and ServiceTitan. Two genuine blind spots have
**no story anywhere** in Phases 0–19:

1. **Membership plans with tiered benefits.** `service_agreements` (P9-003)
   handle *recurring work* (auto-generated jobs/invoices on an RRULE), but they
   do not model a *membership*: a subscription that confers benefits — a
   percentage discount, priority scheduling, and a number of included visits
   per period. This is ServiceTitan's highest-retention feature and the single
   biggest recurring-revenue lever for an owner-operator.

2. **Live online booking against real availability.** The public intake form
   (`public-intake`) captures a lead but cannot offer a real time slot. Jobber
   and ServiceTitan both let a customer self-schedule against the calendar.
   Framed for our product: a **token-scoped public booking page** (not a
   logged-in portal — that remains a PRD non-goal) that offers real open slots
   and creates a **pending booking request** the owner confirms in one tap.

Both stories respect the locked product decisions:
- **No AI-initiated discounting without approval** (PRD §6 out-of-scope-ever):
  member discounts are *surfaced as a suggestion*, never auto-applied to an
  estimate/invoice.
- **Supervisor reviews every booking** (PRD decision #5): an online booking
  creates a *request* in the owner's queue, it does not hard-commit a calendar
  slot.

## Exit Criteria

- An owner defines a "Comfort Club" plan ($19/mo, 10% off all work, priority
  scheduling, 2 included tune-ups/year), enrolls a customer, and sees the
  active membership + remaining included visits on the customer detail page.
- When drafting an estimate for a member, the owner sees the available member
  discount as an **approvable suggestion** (it is not applied automatically).
- A prospect opens `/book/<token>`, picks "AC Tune-Up", sees real open slots
  for the next 14 days computed from live availability, and submits a request.
- The owner receives the request in a queue, taps Confirm, and the system
  creates the appointment + job and texts the customer a confirmation.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P20-001 | Membership plans with tiered benefits + member-discount suggestion | M | CRM / Recurring revenue | Medium | Heavy | P9-003 (agreements patterns), P0-009 (worker) |
| P20-002 | Live online booking against availability (token-scoped public page) | L | Customer-facing / Scheduling | Medium | Heavy | existing `scheduling/`, `availability/`, `public-intake` |

---

## Story Specifications

### P20-001 — Membership plans with tiered benefits + member-discount suggestion

> **Size:** M | **Layer:** CRM / Recurring revenue | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P9-003 (dual-table repo + worker patterns), P0-009 (async worker)

**Allowed files:** `packages/api/src/memberships/**, packages/api/src/routes/memberships.ts, packages/api/src/db/schema.ts (migration 109 only), packages/api/src/app.ts (wiring only), packages/api/src/workers/membership-renewal-worker.ts, packages/web/src/pages/memberships/**, packages/web/src/components/memberships/**, packages/web/src/pages/customers/CustomerDetail.tsx (add membership badge/section only), packages/api/src/memberships/__tests__/**, packages/web/src/pages/memberships/__tests__/**`

**Build prompt:** Implement membership plans, distinct from service agreements. (1) **Schema:** migration `109_create_memberships` with two tables. `membership_plans` (tenant-level definitions): `id, tenant_id, name, description, price_cents (bigint), billing_period (enum: monthly, annual, one_time), discount_bps (int — basis points off labor+material subtotal, e.g. 1000 = 10%), priority_scheduling (bool default false), included_visits_per_period (int, nullable), benefits (jsonb — freeform list of human-readable perks), is_active (bool default true), created_by, created_at, updated_at`. `customer_memberships` (enrollments): `id, tenant_id, customer_id (FK), plan_id (FK to membership_plans), status (enum: active, paused, cancelled, expired), started_on (date), renews_on (date, nullable), ends_on (date, nullable), visits_used_this_period (int default 0), period_started_on (date), last_billed_at (timestamptz, nullable), created_by, created_at, updated_at`. Tenant RLS on both. Partial unique index on `(tenant_id, customer_id) WHERE status = 'active'` (a customer holds at most one active membership). (2) **Repos:** `membership-plan.ts` + `pg-membership-plan.ts`, `customer-membership.ts` + `pg-customer-membership.ts` (interface + InMemory + Pg), following `repository-conventions.md` (tenantId first on every method). Mirror the dual-repo shape in `packages/api/src/agreements/`. (3) **Service:** `membership-service.ts` — plan CRUD (`createPlan`, `updatePlan`, `deactivatePlan`); enrollment (`enrollCustomer` — sets `period_started_on`, computes `renews_on` from `billing_period`; rejects if an active membership already exists), `pauseMembership`, `resumeMembership`, `cancelMembership` (preserves history). Plus two read helpers consumed by other modules: `getActiveMembership(tenantId, customerId): CustomerMembership | null` and `computeMemberDiscountCents(tenantId, customerId, subtotalCents): { discountBps, discountCents, planName } | null`. Plus `consumeIncludedVisit(tenantId, customerId)` (increments `visits_used_this_period`, rejects when limit reached). All mutations emit audit events. (4) **Worker:** `workers/membership-renewal-worker.ts` follows the P0-009 pattern; once per day per tenant, for each active membership past `renews_on`: reset `visits_used_this_period` to 0, advance `period_started_on`/`renews_on`, set `last_billed_at`. Idempotent (a second run in the same period is a no-op). Does NOT charge a card — billing integration is a follow-up; this only rolls the period. (5) **Routes:** `POST /api/membership-plans, GET /api/membership-plans, PATCH /api/membership-plans/:id, POST /api/membership-plans/:id/deactivate, POST /api/customers/:id/membership (enroll), GET /api/customers/:id/membership, POST /api/customers/:id/membership/pause, POST /api/customers/:id/membership/resume, POST /api/customers/:id/membership/cancel`. All Zod-validated. Wire in `app.ts`. (6) **Web:** `MembershipPlanList.tsx` + `MembershipPlanForm.tsx` (settings-area plan management), enrollment control + `MembershipBadge.tsx` (shows plan name, status, included-visits-remaining) added as a section on `CustomerDetail.tsx`. **Do NOT modify estimate or invoice creation** — the discount is surfaced via the read helper `computeMemberDiscountCents`, which the estimate UI will consume as an approvable suggestion in a follow-up story (P20-001b). Document this boundary in the PR.

**Review prompt:** Verify migration 109 is the next sequential number. Verify the partial unique index enforces max-one-active-membership at the DB level, not just app logic. Verify `computeMemberDiscountCents` returns a value but the story does NOT auto-apply it to any estimate/invoice (grep estimates/invoices for membership references — should be zero; the suggestion hook is a separate story). This is the PRD "no AI-initiated discounting without approval" guard. Verify `discount_bps` and `price_cents` are integers (bps + cents, never floats). Verify the worker uses the P0-009 pattern and is idempotent per period. Verify enrollment rejects a second active membership. Verify pause/cancel preserve history. Verify tenant isolation on all repos and routes. Verify `consumeIncludedVisit` rejects past the per-period limit.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- -t "membership|P20-001"
cd packages/web && npm test -- --run -t "Membership|P20-001"
```

**Required tests:**
- [ ] Create plan with discount_bps + included visits → 201
- [ ] Enroll customer → active membership; renews_on computed from billing_period
- [ ] Second enrollment for same customer rejected (partial unique index)
- [ ] `computeMemberDiscountCents` returns correct cents for a subtotal (bps math, integer)
- [ ] `computeMemberDiscountCents` returns null for a non-member
- [ ] `consumeIncludedVisit` increments; rejects past `included_visits_per_period`
- [ ] Renewal worker resets visits + advances period; idempotent on second run
- [ ] Pause prevents benefits; resume restores; cancel preserves history
- [ ] No estimate/invoice file references memberships (discount is suggestion-only)
- [ ] Tenant isolation — plan/membership from tenant A invisible to tenant B
- [ ] Money: discount_bps and price_cents are integers; no float drift in discount

---

### P20-002 — Live online booking against availability (token-scoped public page)

> **Size:** L | **Layer:** Customer-facing / Scheduling | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** existing `packages/api/src/scheduling/`, `packages/api/src/availability/`, `public-intake` pattern, P0-009 (worker for expiry sweep)

**Allowed files:** `packages/api/src/booking/**, packages/api/src/routes/booking.ts, packages/api/src/routes/public-booking.ts, packages/api/src/db/schema.ts (migration 110 only), packages/api/src/app.ts (wiring only), packages/api/src/workers/booking-expiry-worker.ts, packages/web/src/pages/booking/**, packages/web/src/components/booking/**, packages/api/src/booking/__tests__/**, packages/web/src/pages/booking/__tests__/**`

**Build prompt:** Implement token-scoped public online booking. This is NOT a logged-in customer portal (PRD non-goal) — it is a single public page keyed by a per-tenant booking token, like `public-intake`. A submission creates a **pending booking request** the owner confirms; it never hard-commits a calendar slot (PRD decision #5 — supervisor reviews every booking). (1) **Schema:** migration `110_create_online_booking` with two tables. `booking_pages` (one per tenant): `id, tenant_id (unique), token (text unique — 32-byte hex), is_enabled (bool default false), bookable_service_types (jsonb — list of {label, defaultDurationMinutes}), lead_time_hours (int default 24 — earliest bookable offset), horizon_days (int default 14 — how far out to offer slots), created_by, created_at, updated_at`. `online_booking_requests`: `id, tenant_id, booking_page_id (FK), customer_id (uuid, nullable — set when matched), lead_id (uuid, nullable — set when a prospect), requested_service (text), requested_start (timestamptz), requested_end (timestamptz), location_text (text), contact_name, contact_phone, contact_email, notes (text), status (enum: pending, confirmed, declined, expired), created_appointment_id (uuid, nullable), created_job_id (uuid, nullable), decline_reason (text, nullable), created_at, updated_at`. Tenant RLS on both. Index on `(tenant_id, status)` and unique index on `booking_pages.token`. (2) **Slot computation:** `booking/slot-service.ts` — `getOpenSlots(tenantId, serviceType, opts)` reads **(READ ONLY)** the existing `availability/working-hours.ts` + `availability` unavailable-blocks + existing appointments via the scheduling/feasibility modules to produce bookable slots between `now + lead_time_hours` and `now + horizon_days`. Do NOT reimplement availability logic — call the existing `scheduling/booking-availability.ts` / `feasibility.ts`. Slots respect tenant timezone. (3) **Service:** `booking/booking-service.ts` — `getOrCreateBookingPage(tenantId)`, `updateBookingPage`, `resolveBookingToken(token) → { tenantId, bookingPageId } | null` (system-level via `withClient()`, validates `is_enabled`), `submitBookingRequest(...)` (matches `contact_phone` to an existing customer via the dedup/normalize helper; if no match, creates a `source='online_booking'` lead; inserts a `pending` request; emits an owner notification via the existing `notifications/send-service`), `confirmBookingRequest(tenantId, id)` (transactionally: creates an appointment + job from the request, links `created_appointment_id`/`created_job_id`, transitions request to `confirmed`, sends a confirmation SMS to the contact; re-validates the slot is still free and returns a conflict error if taken), `declineBookingRequest(tenantId, id, reason)` (status declined, optional SMS). (4) **Worker:** `workers/booking-expiry-worker.ts` (P0-009 pattern) expires `pending` requests whose `requested_start` is in the past. (5) **Public routes** (no Clerk auth — token middleware mirrors `portal-token-middleware.ts`): `GET /api/public/book/:token/page` (tenant branding + bookable services), `GET /api/public/book/:token/slots?service=&date=` (open slots), `POST /api/public/book/:token/request` (Zod-validated submission; rate-limited). (6) **Authed routes:** `GET /api/booking/page` + `PATCH /api/booking/page` (owner config), `GET /api/booking/requests?status=` (queue), `POST /api/booking/requests/:id/confirm`, `POST /api/booking/requests/:id/decline`. Wire in `app.ts`. (7) **Web:** public `BookingPage.tsx` (routed at `/book/:token`, no auth — service picker, slot grid by day, contact form, tenant-branded) + `BookingRequestQueue.tsx` (owner view — pending requests with Confirm/Decline; lives in the dispatch/queue area).

**Review prompt:** Verify migration 110 is sequential. Verify slot computation **reuses** the existing availability/scheduling/feasibility modules and does NOT duplicate that logic (grep for new availability math — there should be none; it should import existing functions). Verify the booking token is cryptographically random and that the public middleware enforces tenant scoping (the token IS the auth — there is no Clerk session). Verify `submitBookingRequest` creates a request in the *correct* tenant (bound to the token, not user-supplied) and does NOT auto-create an appointment — only `confirmBookingRequest` does. Verify confirm is transactional and re-checks slot availability (a request confirmed for a now-taken slot returns a conflict, does not double-book). Verify a prospect with no customer match creates a `source='online_booking'` lead (the lead source enum must include `online_booking` — extend it in this migration if absent). Verify rate limiting on public endpoints. Verify timezone correctness (slots offered and stored consistent with tenant TZ; DST boundary handled). Verify the expiry worker uses the P0-009 pattern. Verify tenant isolation across every route and the slot query.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- -t "booking|P20-002"
cd packages/web && npm test -- --run -t "Booking|P20-002"
```

**Required tests:**
- [ ] `getOpenSlots` returns slots only within [now+lead_time, now+horizon] and excludes busy/unavailable times
- [ ] `getOpenSlots` reuses existing availability module (no duplicated logic)
- [ ] Public middleware rejects missing/invalid/disabled token (401/404)
- [ ] Submit with a phone matching an existing customer → request.customer_id set, no lead created
- [ ] Submit with an unknown phone → `source='online_booking'` lead created, request.lead_id set
- [ ] Submit creates a `pending` request and does NOT create an appointment
- [ ] Confirm creates appointment + job, links both ids, transitions to confirmed, sends SMS
- [ ] Confirm on a now-taken slot returns conflict, does not double-book
- [ ] Decline sets status + reason; no appointment created
- [ ] Expiry worker marks past-start pending requests as expired; idempotent
- [ ] Rate limiting — burst on public endpoints is throttled
- [ ] Timezone — slot offered in tenant TZ; DST-boundary day handled
- [ ] Tenant isolation — a token from tenant A can never read/write tenant B data
