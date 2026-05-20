# Dispatch Board Dispatcher-Grade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Waves A–C of the dispatch board dispatcher-grade experience — slot-aware drag-and-drop with computed times, live board sync via SSE, and dispatcher presence soft-locks.

**Architecture:** Wave A is web-heavy (pure slot math + dialog + events). Wave B adds `boardRevision` + `DispatchBoardEventBus` + SSE route, bumping revision from scheduling execution handlers. Wave C adds presence store + heartbeat API + card chips. All schedule writes remain proposal-gated; feasibility and `If-Match` stay authoritative.

**Tech Stack:** TypeScript, Express, React, Vitest, Sonner toasts, fetch-based SSE (mirror `useEscalationStream`), optional Redis pub/sub via existing `REDIS_URL`.

**Design spec:** `docs/superpowers/specs/2026-05-20-dispatch-board-dispatcher-grade-design.md`

---

## File map

### Wave A — new (web)

| File | Responsibility |
|------|----------------|
| `packages/web/src/lib/proposal-events.ts` | `PROPOSALS_CHANGED` event helpers |
| `packages/web/src/components/dispatch/compute-proposed-slot.ts` | Pure slot time calculator |
| `packages/web/src/components/dispatch/compute-proposed-slot.test.ts` | Unit tests |
| `packages/web/src/components/dispatch/format-time-range.ts` | Display helper for confirm dialog |

### Wave A — modify (web)

| File | Change |
|------|--------|
| `packages/web/src/pages/dispatch/DispatchBoard.tsx` | Drop index, slot math, reorder, banner, events |
| `packages/web/src/components/dispatch/TechnicianLane.tsx` | Gap drop zones |
| `packages/web/src/components/dispatch/ConfirmProposalDialog.tsx` | Feasibility + time edit + acknowledge |
| `packages/web/src/components/dispatch/AppointmentCard.tsx` | Optional presence chip (Wave C can extend) |
| `packages/web/src/components/inbox/InboxPage.tsx` | `emitProposalsChanged()` |
| `packages/web/src/pages/dispatch/DispatchBoard.test.tsx` | New scenarios |

### Wave B — new (api)

| File | Responsibility |
|------|----------------|
| `packages/api/src/dispatch/board-revision.ts` | Revision bump + get |
| `packages/api/src/dispatch/board-event-bus.ts` | In-process + Redis pub/sub |
| `packages/api/src/dispatch/board-events-route.ts` | SSE `GET /board/events` |
| `packages/api/test/dispatch/board-revision.test.ts` | Revision unit tests |
| `packages/api/test/dispatch/board-events-route.test.ts` | SSE integration |

### Wave B — modify (api)

| File | Change |
|------|--------|
| `packages/api/src/dispatch/board-query.ts` | Include `boardRevision` in response |
| `packages/api/src/dispatch/routes.ts` | Mount events router |
| `packages/api/src/app.ts` | Wire bus + revision deps |
| `packages/api/src/proposals/execution/reschedule-handler.ts` | `bumpDispatchBoardRevision` |
| `packages/api/src/proposals/execution/reassignment-handler.ts` | Same |
| `packages/web/src/hooks/useDispatchBoard.ts` | Track `boardRevision` |
| `packages/web/src/hooks/useDispatchBoardStream.ts` | SSE client |
| `packages/web/src/types/dispatch.ts` | `boardRevision` field |
| `packages/web/src/pages/dispatch/DispatchBoard.tsx` | Subscribe stream |

### Wave C — new (api + web)

| File | Responsibility |
|------|----------------|
| `packages/api/src/dispatch/presence-store.ts` | TTL map |
| `packages/api/src/dispatch/presence-routes.ts` | PUT/DELETE |
| `packages/api/test/dispatch/presence-store.test.ts` | TTL tests |
| `packages/web/src/hooks/useDispatchPresence.ts` | 5s heartbeat |

### Wave C — modify

| File | Change |
|------|--------|
| `packages/api/src/dispatch/board-query.ts` | Merge `editing` onto appointments |
| `packages/api/src/dispatch/board-event-bus.ts` | `publishPresenceUpdated` |
| `packages/web/src/components/dispatch/AppointmentCard.tsx` | Editing chip |
| `packages/web/src/pages/dispatch/DispatchBoard.tsx` | Wire presence hook |

---

# Wave A — Slot insertion & drag loop

### Task A1: `computeProposedSlot` pure function

**Files:**
- Create: `packages/web/src/components/dispatch/compute-proposed-slot.ts`
- Create: `packages/web/src/components/dispatch/compute-proposed-slot.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/web/src/components/dispatch/compute-proposed-slot.test.ts
import { describe, it, expect } from 'vitest';
import { computeProposedSlot } from './compute-proposed-slot';

const H = 60 * 60 * 1000;
function iso(ms: number) { return new Date(ms).toISOString(); }

describe('computeProposedSlot', () => {
  const dayStart = iso(0);
  const workingHours = { start: dayStart, end: iso(24 * H) };

  it('places in empty lane at working hours start', () => {
    const dragged = { scheduledStart: iso(2 * H), scheduledEnd: iso(3 * H) };
    const r = computeProposedSlot({ appointments: [], insertIndex: 0, dragged, workingHours });
    expect(r.placement).toBe('gap');
    expect(new Date(r.proposedScheduledEnd).getTime() - new Date(r.proposedScheduledStart).getTime()).toBe(H);
  });

  it('inserts between A and B when gap fits duration', () => {
    const appointments = [
      { id: 'a', scheduledStart: iso(0), scheduledEnd: iso(2 * H) },
      { id: 'b', scheduledStart: iso(5 * H), scheduledEnd: iso(6 * H) },
    ];
    const dragged = { scheduledStart: iso(10 * H), scheduledEnd: iso(11 * H) };
    const r = computeProposedSlot({ appointments, insertIndex: 1, dragged, workingHours });
    expect(r.placement).toBe('gap');
    expect(r.proposedScheduledStart).toBe(iso(2 * H));
    expect(r.proposedScheduledEnd).toBe(iso(3 * H));
  });

  it('returns overflow when gap too small', () => {
    const appointments = [
      { id: 'a', scheduledStart: iso(0), scheduledEnd: iso(2 * H) },
      { id: 'b', scheduledStart: iso(2 * H + 15 * 60 * 1000), scheduledEnd: iso(5 * H) },
    ];
    const dragged = { scheduledStart: iso(0), scheduledEnd: iso(2 * H) };
    const r = computeProposedSlot({ appointments, insertIndex: 1, dragged, workingHours });
    expect(r.placement).toBe('overflow');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd packages/web && npm test -- compute-proposed-slot.test.ts`  
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// packages/web/src/components/dispatch/compute-proposed-slot.ts
export interface SlotAppointment {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
}

export type SlotPlacement = 'gap' | 'tight' | 'overflow';

export interface ProposedSlot {
  proposedScheduledStart: string;
  proposedScheduledEnd: string;
  placement: SlotPlacement;
}

export function computeProposedSlot(input: {
  appointments: SlotAppointment[];
  insertIndex: number;
  dragged: { scheduledStart: string; scheduledEnd: string };
  workingHours?: { start: string; end: string };
}): ProposedSlot {
  const durationMs =
    new Date(input.dragged.scheduledEnd).getTime() -
    new Date(input.dragged.scheduledStart).getTime();

  const sorted = [...input.appointments].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );

  const defaultStart = input.workingHours?.start ?? input.dragged.scheduledStart;

  let startMs: number;
  if (sorted.length === 0) {
    startMs = new Date(defaultStart).getTime();
  } else if (input.insertIndex <= 0) {
    const firstStart = new Date(sorted[0].scheduledStart).getTime();
    const windowStart = input.workingHours
      ? new Date(input.workingHours.start).getTime()
      : firstStart - durationMs;
    startMs = firstStart - durationMs;
    if (startMs < windowStart) {
      return { proposedScheduledStart: '', proposedScheduledEnd: '', placement: 'overflow' };
    }
  } else if (input.insertIndex >= sorted.length) {
    startMs = new Date(sorted[sorted.length - 1].scheduledEnd).getTime();
  } else {
    const prevEnd = new Date(sorted[input.insertIndex - 1].scheduledEnd).getTime();
    const nextStart = new Date(sorted[input.insertIndex].scheduledStart).getTime();
    if (nextStart - prevEnd < durationMs) {
      return { proposedScheduledStart: '', proposedScheduledEnd: '', placement: 'overflow' };
    }
    startMs = prevEnd;
  }

  const endMs = startMs + durationMs;
  return {
    proposedScheduledStart: new Date(startMs).toISOString(),
    proposedScheduledEnd: new Date(endMs).toISOString(),
    placement: 'gap',
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/dispatch/compute-proposed-slot.ts packages/web/src/components/dispatch/compute-proposed-slot.test.ts
git commit -m "feat(dispatch): add computeProposedSlot for gap-aware drops"
```

---

### Task A2: Gap drop zones in TechnicianLane

**Files:**
- Modify: `packages/web/src/components/dispatch/TechnicianLane.tsx`
- Modify: `packages/web/src/components/dispatch/TechnicianLane.test.tsx`

- [ ] **Step 1: Add `onDragOverGap(insertIndex)` / `onDropGap(insertIndex)` props**

Render a `div.technician-lane__gap` with `data-drop-index={i}` before each card and after the last card. Call `onDragOver` on gaps with `e.stopPropagation()` so parent lane still highlights.

- [ ] **Step 2: Test gap elements exist**

```typescript
expect(container.querySelector('[data-drop-index="0"]')).toBeTruthy();
```

- [ ] **Step 3: Commit** — `feat(dispatch): gap drop zones on technician lanes`

---

### Task A3: Wire DispatchBoard drop index + slot times

**Files:**
- Modify: `packages/web/src/pages/dispatch/DispatchBoard.tsx`
- Modify: `packages/web/src/pages/dispatch/DispatchBoard.test.tsx`

- [ ] **Step 1: Replace `dragOverTarget: string` with `{ technicianId, insertIndex } | '__unassigned__'`**

- [ ] **Step 2: Update `previewInput` to use computed `proposedScheduledStart/End` from `computeProposedSlot`**

- [ ] **Step 3: In `classifyAndOpenConfirm`, attach `proposedTimes` to `pendingDrop`**

- [ ] **Step 4: `submitProposal` uses `pendingDrop.proposedTimes` in reassign/reschedule payloads**

- [ ] **Step 5: Same-lane same-index → `toast.info` + return early**

- [ ] **Step 6: Test — drop between two appointments sets new start to previous end**

- [ ] **Step 7: Commit** — `feat(dispatch): slot-aware drop times on board`

---

### Task A4: Within-lane reorder (P6-020)

**Files:**
- Modify: `packages/web/src/pages/dispatch/DispatchBoard.tsx`

- [ ] **Step 1: Implement `handleReorderWithinLane(appointmentId, fromIndex, toIndex)`**

Swap `scheduledStart`/`scheduledEnd` with neighbor appointment in sorted lane list. Open confirm with `proposalType: 'reschedule_appointment'`.

- [ ] **Step 2: Pass `onReorderWithinLane={handleReorderWithinLane}` to each `TechnicianLane`**

- [ ] **Step 3: Test ↑ triggers dialog and POST body contains swapped times**

Run: `cd packages/web && npm test -- DispatchBoard.test.tsx -t "reorder"`

- [ ] **Step 4: Commit** — `feat(dispatch): wire within-lane reorder proposals`

---

### Task A5: Rich ConfirmProposalDialog

**Files:**
- Modify: `packages/web/src/components/dispatch/ConfirmProposalDialog.tsx`
- Create: `packages/web/src/components/dispatch/ConfirmProposalDialog.test.tsx`

- [ ] **Step 1: Add props `feasibility`, `blockingConfirm`, `onAcknowledgeWarnings`, `timeEdit`**

Render `ConflictDisplay` when `feasibility` provided. Disable confirm when `feasibility.blocking.length > 0`. Show `timeEdit` fields when `placement === 'overflow'`.

- [ ] **Step 2: DispatchBoard passes preview + handles acknowledge state**

- [ ] **Step 3: Commit** — `feat(dispatch): feasibility and time edit in confirm dialog`

---

### Task A6: Conflict banner + proposal events

**Files:**
- Create: `packages/web/src/lib/proposal-events.ts`
- Modify: `packages/web/src/pages/dispatch/DispatchBoard.tsx`
- Modify: `packages/web/src/components/inbox/InboxPage.tsx`

- [ ] **Step 1: Add banner JSX when `conflictIds.size > 0`**

- [ ] **Step 2: `emitProposalsChanged` after inbox approve/reject and board proposal success**

- [ ] **Step 3: `useEffect` listener on `PROPOSALS_CHANGED` → `refetch()`**

- [ ] **Step 4: Commit** — `feat(dispatch): conflict banner and proposal-changed events`

---

### Task A7: Wave A verification

- [ ] Run: `cd packages/web && npm test -- --grep "DispatchBoard|compute-proposed-slot|ConfirmProposal"`
- [ ] Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- [ ] Commit if fixes needed

---

# Wave B — Live board sync

### Task B1: Board revision module

**Files:**
- Create: `packages/api/src/dispatch/board-revision.ts`
- Create: `packages/api/test/dispatch/board-revision.test.ts`

- [ ] **Step 1: Implement in-memory store**

```typescript
import { randomUUID } from 'crypto';

const revisions = new Map<string, string>();

function key(tenantId: string, date: string) {
  return `${tenantId}:${date}`;
}

export function bumpDispatchBoardRevision(tenantId: string, date: string): string {
  const rev = randomUUID();
  revisions.set(key(tenantId, date), rev);
  return rev;
}

export function getDispatchBoardRevision(tenantId: string, date: string): string {
  const k = key(tenantId, date);
  if (!revisions.has(k)) revisions.set(k, randomUUID());
  return revisions.get(k)!;
}
```

- [ ] **Step 2: Test bump changes value**

- [ ] **Step 3: Commit**

---

### Task B2: Board event bus + SSE route

**Files:**
- Create: `packages/api/src/dispatch/board-event-bus.ts`
- Create: `packages/api/src/dispatch/board-events-route.ts`
- Create: `packages/api/test/dispatch/board-events-route.test.ts`

- [ ] **Step 1: Event bus with `subscribe` / `publishBoardUpdated`**

Optional Redis: if `process.env.REDIS_URL`, `PUBLISH dispatch:${tenantId}:${date}` with payload JSON.

- [ ] **Step 2: SSE route** — copy heartbeat pattern from `packages/api/src/escalations/events-route.ts`

Filter events by `tenantId` + query `date`.

- [ ] **Step 3: Integration test** — subscribe, bump revision, receive `board_updated` event

- [ ] **Step 4: Mount in `app.ts` at `/api/dispatch`**

- [ ] **Step 5: Commit**

---

### Task B3: Expose revision on board GET + bump on execution

**Files:**
- Modify: `packages/api/src/dispatch/board-query.ts`
- Modify: `packages/api/src/proposals/execution/reschedule-handler.ts`
- Modify: `packages/api/src/proposals/execution/reassignment-handler.ts`

- [ ] **Step 1: Add `boardRevision: getDispatchBoardRevision(tenantId, date)` to `DispatchBoardData`**

- [ ] **Step 2: After successful execution, derive `date` from appointment `scheduledStart` in tenant TZ, call `bump` + `publishBoardUpdated`**

- [ ] **Step 3: Commit**

---

### Task B4: Web SSE hook

**Files:**
- Create: `packages/web/src/hooks/useDispatchBoardStream.ts`
- Modify: `packages/web/src/hooks/useDispatchBoard.ts`
- Modify: `packages/web/src/pages/dispatch/DispatchBoard.tsx`

- [ ] **Step 1: Implement hook (mirror `useEscalationStream.ts` lines 42–100)**

Parse `data: {"type":"board_updated","boardRevision":"..."}`.

- [ ] **Step 2: `useDispatchBoard` stores `boardRevision` from response**

- [ ] **Step 3: `DispatchBoard` calls hook with `onStale = refetch`**

- [ ] **Step 4: Polling fallback after 60s SSE failure — compare revision only**

- [ ] **Step 5: Commit**

---

### Task B5: Wave B verification

- [ ] Run: `cd packages/api && npm test -- board-revision board-events`
- [ ] Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`

---

# Wave C — Presence & soft-lock

### Task C1: Presence store + routes

**Files:**
- Create: `packages/api/src/dispatch/presence-store.ts`
- Create: `packages/api/src/dispatch/presence-routes.ts`
- Create: `packages/api/test/dispatch/presence-store.test.ts`

- [ ] **Step 1: Store with 15s TTL**

```typescript
export function upsertPresence(entry: {
  tenantId: string;
  date: string;
  userId: string;
  displayName: string;
  appointmentId: string | null;
  mode: 'viewing' | 'dragging';
}): void { /* set expiresAt = now + 15s */ }

export function listPresence(tenantId: string, date: string): PresenceEntry[] {
  return [...].filter(e => e.expiresAt > Date.now());
}
```

- [ ] **Step 2: PUT/DELETE routes with auth**

- [ ] **Step 3: Test TTL expiry**

- [ ] **Step 4: Commit**

---

### Task C2: Enrich board + SSE presence events

**Files:**
- Modify: `packages/api/src/dispatch/board-query.ts`
- Modify: `packages/api/src/dispatch/board-event-bus.ts`

- [ ] **Step 1: For each appointment, set `editing` if another user has `mode:'dragging'` on that id**

- [ ] **Step 2: `publishPresenceUpdated` on PUT/DELETE**

- [ ] **Step 3: Commit**

---

### Task C3: Web presence hook + card chip

**Files:**
- Create: `packages/web/src/hooks/useDispatchPresence.ts`
- Modify: `packages/web/src/components/dispatch/AppointmentCard.tsx`
- Modify: `packages/web/src/pages/dispatch/DispatchBoard.tsx`

- [ ] **Step 1: Heartbeat every 5s; `mode:'dragging'` while `dragSource` set**

- [ ] **Step 2: Card chip when `appointment.editing` and not current user**

- [ ] **Step 3: Confirm dialog soft warning string**

- [ ] **Step 4: Commit**

---

### Task C4: Final verification

- [ ] Run full web dispatch test suite
- [ ] Run API dispatch + presence tests
- [ ] `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- [ ] Manual: two browser profiles — drag on A, see chip on B; approve in inbox, board updates via SSE

---

## Execution order

1. Complete **Wave A** end-to-end (user-visible value).  
2. **Wave B** (requires API deploy before SSE clients).  
3. **Wave C** (depends on B's event bus).

Do not start Wave B until Wave A tests are green.

---

## Allowed modules (story guard)

Per phase-6 conventions:

- `packages/web/src/pages/dispatch/**`
- `packages/web/src/components/dispatch/**`
- `packages/web/src/hooks/useDispatchBoard*.ts`
- `packages/web/src/lib/proposal-events.ts`
- `packages/api/src/dispatch/**`
- `packages/api/src/proposals/execution/reschedule-handler.ts`
- `packages/api/src/proposals/execution/reassignment-handler.ts`
- `packages/api/src/app.ts` (wiring only)
