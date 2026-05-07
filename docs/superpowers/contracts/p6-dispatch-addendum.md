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

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md` § Universal pre-flight checks. Apply to every Phase 6 story before launching the dispatch agent.
