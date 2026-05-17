# Phase 6 (Dispatch UI) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-6-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent running in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-6-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 6A | P6-025 | single agent (drag-drop interaction is a UX-sensitive surface) | unlocks P6-026 visual layer |
| 6B | P6-026 | parallel-eligible after 6A merges | none |
| 6C | P6-027 | parallel-eligible after 6A merges | none |

P6-025 ships first because the conflict-badge work (P6-026) and the auto-refresh work (P6-027) both consume the same `DispatchBoard` parent component. Letting 6A land first keeps the merge surface clean.

---

## P6-025 — Wire drag-and-drop handlers in DispatchBoard

**Wave:** 6A
**Migration number reserved:** none (UI-only)
**Forbidden files:**
- `packages/api/**` (no backend changes; the `reassign_appointment`, `reschedule_appointment`, `cancel_assignment` proposal contracts already exist in `packages/api/src/proposals/contracts/`)
- `packages/shared/**`
- `packages/web/src/components/auth/**` (P0-029 owns this)
- `packages/web/src/hooks/useListQuery.ts` (do not refactor)

**Allowed files (concrete list):**
- `packages/web/src/components/dispatch/DispatchBoard.tsx` (modify — wire handlers)
- `packages/web/src/components/dispatch/AppointmentCard.tsx` (modify only if drag-source state needs adjustments)
- `packages/web/src/components/dispatch/TechnicianLane.tsx` (modify only if drop-target state needs adjustments)
- `packages/web/src/components/dispatch/UnassignedQueue.tsx` (modify only if it exists; otherwise skip)
- `packages/web/src/components/dispatch/ConfirmProposalDialog.tsx` (new, if no existing confirmation primitive fits)
- `packages/web/src/pages/dispatch/DispatchBoard.test.tsx` or `packages/web/src/components/dispatch/DispatchBoard.test.tsx` (modify/new)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npm run typecheck && \
  npm test --workspace=packages/web -- --run -t "P6-025|DispatchBoard|drag"
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- The three proposal types (`reassign_appointment`, `reschedule_appointment`, `cancel_assignment`) exist as exported Zod schemas in `packages/api/src/proposals/contracts/`. The agent reads them via the shared package barrel — does NOT redefine them.

**Risk note:**
- **No direct mutations.** This is the cardinal rule: drag-and-drop creates a *proposal*; the visual position of the appointment must NOT change until the proposal is approved (the existing 5-second undo window applies post-approval, not at drag time). Tests must assert the source-position stays put on drop.
- **Mobile fallback.** `dnd-kit` (already in package.json — verify) supports touch sensors; if the dependency isn't present, fall back to gracefully disabling drag on touch devices and surfacing a "use the proposal action menu instead" hint. Do NOT add a new dependency.
- **Accessibility.** Drag-drop is keyboard-hostile by default. Provide a keyboard-equivalent action: focus a card → press Space → arrow keys to navigate lanes → Enter to commit (open the same confirmation dialog). If full kbd support is too big in this story, surface the gap explicitly and ship with a follow-up note.

**Implementation hints:**
1. Read `dispatch/DispatchBoard.tsx` first. The story claims `draggable=true`, `onDragStart`, `onDragOver`, `onDrop` are already present on child components. Verify; if they're not, this story silently grows. Surface that finding in the PR description rather than expanding scope.
2. Use the existing `useMutation` hook (recently extended with toast support per P0-032 / PR #186) so success/failure feedback comes free.
3. The proposal request shape:
   ```ts
   POST /api/proposals
   {
     type: 'reassign_appointment',
     payload: { appointmentId, newTechnicianId, scheduledStart, scheduledEnd, reason },
     idempotencyKey: '<uuid-v4 generated client-side>'
   }
   ```
   Idempotency key prevents double-submit on accidental double-drop.
4. Drop-on-same-lane → `reschedule_appointment` (different time, same tech). Drop-on-different-lane → `reassign_appointment` (same time, different tech). Drop-on-unassigned-queue → `cancel_assignment`. Decide which by inspecting the drop target's data attributes.

---

## P6-026 — Conflict visibility badges on appointment cards

**Wave:** 6B (after 6A merges)
**Status:** addendum stub — extend with full block when ready to dispatch.
**Open question:** does conflict detection require new backend (an `/api/dispatch/conflicts?date=...` endpoint) or can it be computed client-side from already-loaded appointment data? Read `dispatch/conflict-detector.ts` (if exists) before deciding.

---

## P6-027 — Board refresh after proposal execution

**Wave:** 6C (after 6A merges)
**Status:** addendum stub. Likely small (extend `useDispatchBoard` query invalidation when a proposal-execution event fires). Decide between websocket vs poll vs query-invalidation-on-mutation-success.

---

## P6-028 — Tech "I'm out today" SMS

**Wave:** 6-Wave-C1 (depends on Wave-C blockers B1 = P4-015, B2 = P2-035, B3 = P2-034, B4 = P1-022)
**Migration numbers reserved:**
- `103_tech_unavailable_blocks` — PG-backed equivalent of the existing in-memory `availability/unavailable-block.ts`
- `104_tech_status_today` — daily idempotency key

**Forbidden files:**
- `packages/api/src/users/**` (P1-022 owns the `mobile_number` column and `findByMobileNumber()`)
- `packages/api/src/webhooks/routes.ts` (P2-034 owns the inbound-SMS dispatch edit)
- `packages/api/src/proposals/actions.ts` (P2-035 owns the batch-approve edit)
- `packages/api/src/ai/prompt-registry.ts` (P4-015 owns the brand-voice prompt registration)
- `packages/api/src/availability/unavailable-block.ts` (the in-memory implementation stays for tests — extend, do not refactor)
- `packages/api/src/proposals/contracts/reschedule.ts` (the contract already exists — reuse, do not redefine)
- `packages/shared/**` (except `packages/shared/src/contracts/tech-status-event.ts` — the one new shared contract)
- `packages/api/src/notifications/**` (outbound SMS is reused, not modified)

**Allowed files (concrete list):**
- `packages/api/src/sms/tech-status/keyword-router.ts` (new — registers `OUT|SICK|UNAVAILABLE` with P2-034's dispatcher)
- `packages/api/src/sms/tech-status/handler.ts` (new — resolve tech, check idempotency, write block, walk appointments, fire proposals)
- `packages/api/src/sms/tech-status/idempotency.ts` (new — short-circuit on existing `tech_status_today` row)
- `packages/api/src/sms/tech-status/index.ts` (new — module init: call `registerKeywordHandler`)
- `packages/api/src/sms/tech-status/**.test.ts` (new)
- `packages/api/src/scheduling/reschedule/from-tech-out.ts` (new — find remaining appointments, create proposals)
- `packages/api/src/scheduling/reschedule/customer-message-draft.ts` (new — composes per-proposal SMS via P4-015 composer)
- `packages/api/src/scheduling/reschedule/**.test.ts` (new)
- `packages/api/src/availability/pg-unavailable-block.ts` (new — PG-backed implementation; in-memory stays)
- `packages/api/src/availability/pg-unavailable-block.test.ts` (new)
- `packages/api/src/db/schema.ts` (modify — add keys 103 + 104)
- `packages/shared/src/contracts/tech-status-event.ts` (new)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "P6-028|tech-status|tech_out|reschedule_from_tech"
```

**Pre-flight:** all six Wave-C blockers have merged on `main`:
- P4-015 (brand voice composer)
- P1-022 (users.mobile_number)
- P0-037 (LinkableEntityType — not strictly required for this story but Wave-C convention)
- P2-034 (inbound SMS dispatcher)
- P2-035 (APPROVE ALL endpoint)

**Risk note:**
- **Anti-spoofing.** Inbound `OUT` from the OWNER's mobile must not mark Carlos out. The handler resolves the inbound mobile to a user via `findByMobileNumber(tenantId, fromE164)`. If the resolved user's role is not `'technician'`, drop + audit. Do NOT trust the body content for identity.
- **Tenant-local midnight.** "Today" is the technician's tenant-local date. Use `tenants.timezone` to compute the `local_date` for the idempotency key and the start/end of the `unavailable_blocks` row. Do NOT use server-local time.
- **Atomic propagation.** Each reschedule proposal is created with `sourceContext.draftSms` already populated. APPROVE ALL via P2-035 then approves each individually — each `approveProposal()` call fires the `execute` handler which sends the customer SMS. The handler must be idempotent so a retry doesn't double-send.
- **3+ proposal threshold is client-side only.** The backend just creates N proposals; the inbox UI decides when to show APPROVE ALL. Do NOT enforce a server-side threshold.
- **Midnight clear is implicit.** The daily `tech_status_today` key uses `local_date` as part of the PK. A new day → no row → idempotency passes → status is "fresh". No cron needed.

**Implementation hints:**
1. Read `packages/api/src/sms/inbound-dispatch.ts` (P2-034) BEFORE writing `keyword-router.ts` — use its `registerKeywordHandler()` API.
2. The handler resolves tech via `await users.findByMobileNumber(tenantId, fromE164)`; null → audit `tech_status.unverified_mobile` + return `{handled: false, reason: 'unknown_mobile'}` (truthful — Twilio's seen this message; do not return `handled: true` for unknown).
3. The idempotency check is a `SELECT ... FOR UPDATE` on `tech_status_today (tenant_id, technician_id, local_date)`; if a row exists → return early. Otherwise insert and proceed.
4. The `unavailable_blocks` row spans today: `start_time = tenant_local_midnight`, `end_time = tenant_local_midnight + 24h`, `reason = body.trim().toLowerCase()`.
5. Reschedule walk: `appointments.findUpcomingForTechnician(tenantId, technicianId, fromTime: NOW(), toTime: tenant_local_midnight + 24h)`. For each, create a `reschedule_appointment` proposal with `sourceContext.draftSms = await composeBrandVoiceMessage({intent: 'tech_reschedule_customer_sms', context: {customerName, appointmentTime}, maxChars: 160})`.
6. **Migration 104 body** (final form):
   ```sql
   CREATE TABLE tech_status_today (
     tenant_id UUID NOT NULL REFERENCES tenants(id),
     technician_id UUID NOT NULL REFERENCES users(id),
     local_date DATE NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('out','sick','unavailable')),
     source_message_sid TEXT NOT NULL,
     recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, technician_id, local_date)
   );
   ALTER TABLE tech_status_today ENABLE ROW LEVEL SECURITY;
   -- standard tenant policy
   ```

---

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md` § Universal pre-flight checks. Apply to every Phase 6 story before launching the dispatch agent.
