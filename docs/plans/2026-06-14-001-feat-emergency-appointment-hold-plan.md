# feat: Emergency dispatch appointment-hold

**Created:** 2026-06-14
**Depth:** Standard
**Status:** plan

## Summary

The `EmergencyDispatchExecutionHandler` (RV-141, shipped in PR #551) creates
an urgent job and pages the on-call owner by SMS when an `emergency_dispatch`
proposal executes — but it deliberately does **not** create an appointment
hold (documented deviation in
`packages/api/src/proposals/execution/emergency-dispatch-handler.ts`). This
plan closes that deviation safely: on emergency execution, find the soonest
feasible slot and create a **tentative held appointment**
(`holdPendingApproval: true` with a short `holdExpiryAt`) linked to the urgent
job, so a dispatcher sees the emergency pre-slotted on the board and only has
to confirm it. The hold is reversible and visible, never a committed booking —
which both preserves the human-approval gate and answers the original
deviation's concern that "a wrong auto-picked slot on an emergency is worse
than none."

> **Context:** The rest of 3A ("emergency detection fast-path") is already
> built and merged — RV-140 (deterministic keyword detector), RV-141
> (execution handler), RV-142 (911 safety script), RV-143 (page-retry ladder),
> all PR #551. The `3A` entry in `docs/remaining-features.md` is **stale**.
> This plan is the one genuinely-open sub-piece, not a rebuild.

## Problem Frame

When an emergency is detected on a call, the owner is paged and an urgent job
lands on the dispatch board, but no time slot is reserved. A dispatcher must
manually find and book a slot under time pressure. Closing the documented
appointment-hold deviation shaves that step down to a one-tap confirmation
while keeping a human in the loop.

## Requirements

- **R1.** On `emergency_dispatch` execution for an **identified** caller (a job
  was created), attempt to create a tentative held appointment on the soonest
  feasible slot for that urgent job.
- **R2.** The held appointment uses `holdPendingApproval: true` + a short
  `holdExpiryAt`; it is **not** a confirmed booking and never bypasses human
  approval — a human confirms it via the existing confirm-hold path
  (`create-booking-handler.ts`), which clears the flag.
- **R3.** If no feasible slot is found, no `AvailabilityFinder` is wired, or the
  caller is anonymous, fall back to current behavior (urgent job + owner page).
  The hold attempt must **never** fail or delay the emergency escalation.
- **R4.** Hold creation is idempotent on re-run (RV-143 page-retry ladder,
  repeated keyword detection) — no duplicate holds.
- **R5.** Hold creation emits an audit event; the owner-page copy mentions the
  held slot only when a hold actually landed.

## Key Technical Decisions

- **Tentative hold, not auto-book.** Create the appointment with
  `holdPendingApproval: true` + `holdExpiryAt`, reusing existing hold
  semantics. *Rationale:* honors the never-auto-execute invariant (a human
  confirms) and directly addresses the deviation's "wrong slot worse than none"
  concern — a hold is reversible and visible; a booking is not. *Alternative:*
  fully auto-book the soonest slot — rejected (violates the approval gate; a
  wrong committed emergency slot causes real harm).
- **Inject `AvailabilityFinder` as an optional dep** via
  `createExecutionHandlerRegistry`. *Rationale:* the handler header prescribes
  exactly this; keeping it optional preserves the documented graceful-fallback
  when deps aren't wired (tests, minimal deploys). *Alternative:* required dep —
  rejected (breaks the degradation contract the handler already documents).
- **Delegate slot selection to `AvailabilityFinder`** (working-hours +
  assignment-conflict machinery in `scheduling/booking-availability.ts`); do
  not re-implement scheduling logic in the handler.
- **Page first, hold second.** Order side effects so the owner page and urgent
  job land before the availability lookup runs, so the page never waits on
  scheduling. A hold failure is swallowed (logged, audited as skipped).

## Scope Boundaries

**In scope:** extend `EmergencyDispatchExecutionHandler` to create a tentative
hold; wire `AvailabilityFinder`/appointment repo into the execution registry;
audit + page-copy changes; unit + integration tests.

**Non-goals:** the emergency detector (RV-140), 911 script (RV-142),
page-retry ladder (RV-143), and FSM fast-path (`transitions.ts`) — all shipped
and unchanged. The confirm-hold approval flow (`create-booking-handler.ts`
already handles it). Per-tenant emergency keywords (separate supervisor-policy
track, per the detector's own TODO).

### Deferred to follow-up work
- Special-casing the held emergency slot's appearance on the spatial board
  (the board already renders holds).
- Telephony read-back copy announcing the held time to the caller.

## Repository invariants touched

- **Human-approval gate:** the hold is tentative (`holdPendingApproval: true`),
  confirmed only by a human via the existing approval path — no auto-execution
  of a real booking.
- **`tenant_id` + RLS:** appointment + job created with `tenantId` through the
  existing repos.
- **Audit events:** emitted on hold creation (and on a skipped-hold outcome).
- **Times UTC:** `holdExpiryAt` stored UTC; page copy renders the slot in the
  tenant timezone.
- **Integer cents / LLM gateway / catalog resolver / entity resolver:** not
  touched — this is a deterministic execution-path change with no pricing or
  model calls.

## Implementation Units

### U1. Thread `AvailabilityFinder` into the emergency handler's deps
- **Goal:** make `AvailabilityFinder` and the appointment repo available
  (optionally) to `EmergencyDispatchExecutionHandler` via the registry, with
  zero behavior change when they're absent.
- **Requirements:** R3 (fallback contract)
- **Dependencies:** none
- **Files:**
  - `packages/api/src/proposals/execution/emergency-dispatch-handler.ts`
  - `packages/api/src/proposals/execution/handlers.ts` (registry factory signature)
  - `packages/api/src/app.ts` (pass the real `AvailabilityFinder` + appointment repo)
  - `packages/api/test/proposals/emergency-dispatch-handler.test.ts`
- **Approach:** add optional `availabilityFinder?` and `appointmentRepo?` to the
  handler's deps and to `createExecutionHandlerRegistry`; wire the existing
  instances in `app.ts`. Absent deps → current code path exactly.
- **Patterns to follow:** how `create-booking-handler.ts` receives its repos via
  the registry; the existing dep-injection shape in `handlers.ts`.
- **Test scenarios:**
  - Happy path: registry passes the finder + appointment repo when provided.
  - Edge: deps absent → `emergency_dispatch` still registers and the existing
    handler tests (job + page) stay green (regression guard).
  - `Test expectation: none` for the `app.ts` wiring line itself (covered by U2's integration test).
- **Verification:** `tsc --project tsconfig.build.json` clean; the existing
  RV-141 handler test suite passes unchanged.

### U2. Create a tentative hold on the soonest feasible slot
- **Goal:** when the finder + appointment repo are present and a job was created
  for an identified caller, find the soonest feasible slot and create a held
  appointment (`holdPendingApproval: true`, `holdExpiryAt = now + HOLD_TTL`)
  linked to the urgent job.
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** U1
- **Files:**
  - `packages/api/src/proposals/execution/emergency-dispatch-handler.ts`
  - reuse `packages/api/src/scheduling/booking-availability.ts` (`AvailabilityFinder`)
  - reuse `packages/api/src/appointments/appointment.ts` (`createAppointment` + repo, hold fields)
  - `packages/api/test/proposals/emergency-dispatch-handler.test.ts`
  - `packages/api/test/integration/emergency-dispatch-hold.test.ts` (new)
- **Approach:** after the urgent job is created, query the finder for the job's
  service/duration, pick the soonest feasible slot, and create an appointment
  linked to the job with the hold fields set (`holdExpiryAt` in UTC). No slot,
  no finder, or anonymous caller → skip the hold and return the existing
  job+page success. Make it idempotent by reusing the handler's existing
  `resultEntityId` / durable audit-marker pattern so a re-run finds the prior
  hold instead of creating a second.
- **Patterns to follow:** hold field usage in `create-booking-handler.ts`
  (`holdPendingApproval`, `holdExpiryAt`) and `appointments/pg-appointment.ts`
  column mapping (`hold_pending_approval`, hold expiry).
- **Test scenarios:**
  - Happy path: identified caller + feasible slot → held appointment created
    with `holdPendingApproval: true`, `holdExpiryAt` set, linked to the urgent job.
  - Edge: no feasible slot (after-hours / fully booked) → no hold; job + page
    still succeed.
  - Edge: anonymous caller (no job) → no hold; page still succeeds.
  - Error/idempotency: handler re-run (RV-143 retry) → no duplicate hold.
  - Integration (Docker-gated, `packages/api/test/integration/`): execute against
    a real Postgres — assert the row lands with `hold_pending_approval = true`,
    a non-null expiry, and the job FK; **pin the real columns** (mocked-DB proof
    is insufficient per `CLAUDE.md`).
- **Verification:** unit + integration tests green; the created hold is
  recognized by the confirm-hold path in `create-booking-handler.ts`.

### U3. Audit + owner-page copy reflect the held slot
- **Goal:** emit an audit event for the hold outcome; when a hold was created,
  the owner SMS names the held time so the human knows a slot is reserved
  pending confirmation.
- **Requirements:** R5
- **Dependencies:** U2
- **Files:**
  - `packages/api/src/proposals/execution/emergency-dispatch-handler.ts`
  - `packages/api/test/proposals/emergency-dispatch-handler.test.ts`
- **Approach:** `createAuditEvent` for the hold (created or skipped-with-reason);
  extend the owner-page body builder to append a "Held <time> pending your
  confirmation" clause only when a hold landed. Render the time in the tenant
  timezone while storing UTC.
- **Patterns to follow:** existing `createAuditEvent` call sites in the handler;
  the existing page-copy builder.
- **Test scenarios:**
  - Happy path: hold created → audit event emitted AND page copy includes the
    held time (tenant-timezone rendered).
  - Edge: fallback (no hold) → page copy unchanged; a skipped-hold audit event
    records the reason.
- **Verification:** tests assert both the audit and page-copy branches.

## Risks & Dependencies

- **Availability latency on the emergency path.** Mitigated by U2's
  "page first, hold second" ordering — the page/job never block on scheduling,
  and a hold failure is swallowed (R3).
- **Wrong-slot harm** (the original deviation's concern). Mitigated by
  hold-not-book + short `holdExpiryAt` + mandatory human confirm.
- **Hold-expiry coverage.** Confirm the existing hold-expiry mechanism
  (`holdExpiryAt` / `isHoldExpired` in `appointments/appointment.ts`) reaps
  these holds with no special-casing — verify during U2.

## Open Questions  (defer to implementation)

- Exact `HOLD_TTL` for emergencies (30 min vs shorter) — make it a named constant.
- Which assignee the hold targets (any feasible tech vs on-call) — depends on
  the `AvailabilityFinder` interface; resolve when wiring U2.
- Whether the owner page should include a deep link to confirm the hold —
  depends on existing page-copy/link infrastructure.

## Sources & Research

Internal only; verified against
`packages/api/src/proposals/execution/emergency-dispatch-handler.ts` (the
documented deviation), `create-booking-handler.ts` (hold-confirm semantics),
`scheduling/booking-availability.ts` (`AvailabilityFinder`),
`appointments/appointment.ts` (hold fields), and
`docs/superpowers/plans/2026-06-11-rivet-architect-plan.md` RV-140–143 (PR #551).
No external research was load-bearing.
