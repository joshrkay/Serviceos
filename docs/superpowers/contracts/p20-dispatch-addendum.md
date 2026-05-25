# Phase 20 (CRM Parity Net-New) — Multi-Agent Dispatch Addendum

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 20A | P20-001, P20-002 | parallel (disjoint domains: `memberships/**` vs `booking/**`; neither touches a shared interface) | sprint complete |

Both stories are greenfield modules in their own directories and reserve
non-overlapping migration numbers, so they run fully in parallel. Each touches
`app.ts` (wiring only) and `CustomerDetail.tsx` / the queue area additively —
coordinate the two `app.ts` edits at merge (trivial, additive).

## Migration ledger

- 109: P20-001 `membership_plans` + `customer_memberships`
- 110: P20-002 `booking_pages` + `online_booking_requests` (+ extend lead `source` enum with `online_booking` if absent)

---

## P20-001 — Membership plans

**Wave:** 20A
**Migration number reserved:** 109
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/estimates/**` (READ-ONLY — discount is a suggestion, applied in a separate story)
- `packages/api/src/invoices/**` (READ-ONLY — same reason)
- `packages/api/src/agreements/**` (separate entity; mirror the pattern, don't edit it)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "membership|P20-001") && \
  (cd packages/web && npm test -- --run -t "Membership|P20-001")
```

**Risk note:**
- **No auto-discount**: the cardinal guard. `computeMemberDiscountCents` exists, but nothing in `estimates/**` or `invoices/**` calls it in this story. PRD §6: no AI-initiated discounting without owner approval. The application hook is P20-001b.
- **Max-1-active**: enforce via partial unique index `WHERE status='active'`, not just app logic.
- **Money**: `discount_bps` (basis points) and `price_cents` (cents) are integers. Discount = `Math.round(subtotalCents * discount_bps / 10000)` — integer arithmetic only.
- **Worker rolls period, does not charge**: card billing is explicitly out of scope here.

**Implementation hints:**
1. Mirror `packages/api/src/agreements/` (P9-003) for the dual-table repo + worker shape.
2. `MembershipBadge` on CustomerDetail mirrors the existing agreement/section pattern on that page.

---

## P20-002 — Live online booking

**Wave:** 20A
**Migration number reserved:** 110
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/scheduling/**` (READ-ONLY — reuse `booking-availability.ts` / `feasibility.ts`, do not modify)
- `packages/api/src/availability/**` (READ-ONLY — reuse working-hours + unavailable-blocks)
- `packages/api/src/appointments/**` (READ-ONLY except via the service layer's create call; do not change the appointment FSM)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "booking|P20-002") && \
  (cd packages/web && npm test -- --run -t "Booking|P20-002")
```

**Risk note:**
- **No hard-commit**: a public submission creates a `pending` request only. The appointment/job are created exclusively in `confirmBookingRequest` (owner action). PRD decision #5 — supervisor reviews every booking.
- **Reuse availability**: do NOT reimplement slot math. Import the existing scheduling/feasibility functions. A reviewer greps for new availability logic — there should be none.
- **Token is the auth**: public middleware mirrors `portal-token-middleware.ts`; enforce tenant scoping on every downstream query.
- **Confirm re-validates slot**: between request and confirm the slot may be taken; confirm must re-check and return a conflict rather than double-book.
- **Lead source enum**: add `online_booking` if not already present (migration 110 ALTER).
- **Timezone/DST**: slots computed and stored in tenant TZ; handle the spring-forward gap.

**Implementation hints:**
1. Mirror `public-intake` for the public token-scoped page + route shape.
2. Mirror `portal/portal-token-middleware.ts` for token resolution.
3. `BookingRequestQueue` lives in the dispatch/queue area; Confirm/Decline are one-tap, consistent with the proposal-approval affordance.
