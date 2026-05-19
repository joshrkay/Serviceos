# Phase 6 — Dispatch Board + Scheduling: Launch Readiness Gaps

> **4 stories** | Continues from P6-024

---

## Purpose

The dispatch board UI is 90% built — technician lanes, appointment cards, unassigned queue, date navigation, filters, and summary strip all exist. The gap is wiring the drag-and-drop interaction to create real schedule proposals, showing conflict indicators, and refreshing the board after changes.

## Exit Criteria

Dispatchers can drag appointments between lanes to create reassignment/reschedule proposals; conflict indicators appear on overlapping appointments; the board refreshes after proposal execution.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P6-025 | Wire drag-and-drop handlers in DispatchBoard to create schedule proposals | S | Dispatch UI | Medium | Heavy | P6-007, P6-008, P2-010 |
| P6-026 | Conflict visibility badges on appointment cards | S | Dispatch UI | High | Moderate | P6-016, P6-017, P6-002 |
| P6-027 | Board refresh after proposal execution | S | Dispatch UI | High | Light | P6-025, P2-010 |

---

## Story Specifications

### P6-025 — Wire drag-and-drop handlers in DispatchBoard to create schedule proposals

> **Size:** S | **Layer:** Dispatch UI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P6-007, P6-008, P2-010

**Allowed files:** `packages/web/src/components/dispatch/**, packages/web/src/pages/dispatch/**`

**Build prompt:** The TechnicianLane and AppointmentCard components already have `draggable=true`, `onDragStart`, `onDragOver`, and `onDrop` props defined. The DispatchBoard parent component does NOT wire these handlers. Implement: (1) `onDragStart` — capture the appointment being dragged and its source lane. (2) `onDragOver` — highlight the target lane/time slot as a valid drop zone. (3) `onDrop` — when an appointment is dropped on a different technician's lane, call `POST /api/proposals` with a `reassign_appointment` proposal payload containing the appointment ID, new technician ID, and proposed time. (4) When dropped on the unassigned queue, create a `cancel_assignment` proposal. (5) Show a confirmation dialog before creating the proposal (drag is intent, not execution). (6) After proposal creation, show a toast with a link to the proposal detail for review.

**Review prompt:** Verify drag-and-drop creates proposals, NOT direct mutations (safety-first pattern). Verify confirmation dialog before proposal creation. Verify the correct proposal type is created (reassign vs reschedule). Verify visual feedback during drag (lane highlighting). Verify the original appointment position doesn't change until the proposal is approved. Check mobile — drag-and-drop should gracefully degrade (touch events or disabled).

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-025"
```

**Required tests:**
- [ ] Reassign — drag to different tech creates reassign proposal
- [ ] Confirmation — dialog shown before proposal creation
- [ ] No direct mutation — appointment stays in original position until approved
- [ ] Visual feedback — target lane highlighted during drag
- [ ] Toast — proposal created toast with link shown
- [ ] Unassigned — drag to queue creates cancel assignment proposal
- [ ] Same lane — drag within same lane creates reschedule proposal

---

### P6-026 — Conflict visibility badges on appointment cards

> **Size:** S | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P6-016, P6-017, P6-002

**Allowed files:** `packages/web/src/components/dispatch/**`

**Build prompt:** The backend has conflict detection (P6-016 overlapping appointments, P6-017 availability block conflicts). Wire the results to the dispatch board UI: (1) The board query response (`GET /api/dispatch/board`) should include conflict flags on each appointment. (2) AppointmentCard should show a warning badge (amber icon) when the appointment overlaps with another on the same technician. (3) Show a red badge when the appointment falls in an unavailable block. (4) Hovering the badge should show a tooltip explaining the conflict (e.g., "Overlaps with 2:00 PM - Smith residence"). (5) Conflicting appointments in the same lane should have a visual connector or overlap indicator.

**Review prompt:** Verify conflict data comes from the API (not calculated client-side). Verify badge colors match severity (amber for overlap, red for availability block). Verify tooltip text is clear and actionable. Check that conflict detection doesn't slow down the board query.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-026"
```

**Required tests:**
- [ ] Overlap badge — shown on overlapping appointments
- [ ] Availability badge — shown during unavailable block
- [ ] Tooltip — explains the conflict clearly
- [ ] No conflict — no badge shown on clean appointments
- [ ] Multiple conflicts — badge shows count

---

### P6-027 — Board refresh after proposal execution

> **Size:** S | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P6-025, P2-010

**Allowed files:** `packages/web/src/components/dispatch/**, packages/web/src/hooks/**`

**Build prompt:** After a schedule proposal (reassignment, reschedule, cancellation) is approved and executed from the dispatch board, the board should refresh to reflect the new state. Implement: (1) After proposal approval (via inline action or proposal detail), trigger a board data refetch. (2) Show a brief transition animation on the moved appointment card. (3) Update the summary strip metrics (total appointments, unassigned count). (4) If the proposal was rejected, show a toast explaining why and leave the board unchanged. Polling-based refresh (every 30 seconds) is acceptable as a baseline; optimistic UI updates on known actions are preferred.

**Review prompt:** Verify board refreshes after approval. Verify metrics update. Verify rejection doesn't change board state. Check that refresh doesn't cause layout jumps or scroll position loss.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P6-027"
```

**Required tests:**
- [ ] Refresh — board updates after proposal approval
- [ ] Metrics — summary strip recalculates
- [ ] Rejection — board unchanged, toast shown
- [ ] Scroll position — preserved during refresh
- [ ] Concurrent — two dispatchers see consistent state

---

### P6-028 — Tech "I'm out today" SMS

> **Size:** M | **Layer:** SMS / Scheduling | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 2 (Wave-C1)

> **PRD codename:** N-010 (PRD v2 §9)
> **Day-in-the-life moments:** Mike bad-day 5:00pm (Carlos no-shows because there's no way to mark out).

**Dependencies:** P1-008 (technician assignment), P2-034 (SMS dispatcher), P1-022 (users.mobile_number), P2-035 (APPROVE ALL), P4-015 (brand voice), P7-001 (Twilio)

**Allowed files:** `packages/api/src/sms/tech-status/**`, `packages/api/src/scheduling/reschedule/**`, `packages/api/src/availability/pg-unavailable-block.ts`, `packages/api/src/db/schema.ts`, `packages/shared/src/contracts/tech-status-event.ts`

**Build prompt:** Allow a technician to mark themselves out for the current day by replying `OUT`, `SICK`, or `UNAVAILABLE` to the shop's SMS number from their registered mobile. On receipt: (a) update the tech's status for today; (b) for each of the tech's remaining appointments today, generate a `reschedule_appointment` proposal routed to the owner; (c) draft a customer-facing reschedule SMS in brand voice (P4-015) attached to each proposal — the owner approves and the customer is notified atomically. The owner can approve all in one tap if multiple proposals are pending ("APPROVE ALL"). Use P2-034's keyword dispatcher to register `OUT|SICK|UNAVAILABLE`. Use P1-022's `findByMobileNumber()` for identity binding. Use P2-035's batch endpoint for owner UX. Persist tech status to a new PG-backed `unavailable_blocks` table (migration 103) and a daily idempotency key in `tech_status_today` (migration 104).

**Review prompt:** Verify tech identity is bound to the inbound number (no spoofing via owner's own number). Verify same-day scope only. Verify reschedule proposals are batched if 3+ for one-tap approval. Verify customer SMS uses brand voice. Verify the appointment status transitions atomically with proposal approval. Confirm "midnight clear" emerges from the `local_date` PK (no cron needed).

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P6-028"
```

**Required tests:**
- [ ] Tech replies OUT → status updates and reschedule proposals fire
- [ ] Owner APPROVE ALL applies to all pending tech-status reschedules
- [ ] Customer SMS uses brand voice
- [ ] Wrong-number inbound is rejected (not a registered tech)
- [ ] Idempotent — second OUT reply same day is a no-op
- [ ] Status auto-clears at midnight tenant-local

**Non-goals:** Multi-day out status (V2); partial-day (e.g., "out after 2pm"); auto-rescheduling without owner approval.
