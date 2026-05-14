# Held-Slot Scheduling Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI-booked calendar slots "first-class held slots" — an appointment can exist as a tentative hold awaiting owner approval, gets confirmed on approval and released on rejection — and make availability buffer-aware so the voice agent never offers back-to-back slots.

**Architecture:** A held appointment is a normal `appointments` row with a new `hold_pending_approval` boolean flag + a `hold_expiry_at` timestamp. The inbound voice agent, when wired with an appointment repo, creates the held appointment up front and emits a new `create_booking` proposal (payload `{ appointmentId }`); approving it runs `CreateBookingExecutionHandler` which clears the flag, rejecting it cancels the held appointment. The availability finder pads busy intervals by a configurable buffer and treats expired holds as free (read-time release — no background worker). Every schedule mutation (book / reschedule / cancel) emits an `appointment.*` audit event so the customer-communications subsystem (a later plan) has a consistent event stream to listen on.

**Tech Stack:** TypeScript, Express, Postgres (raw SQL migrations + RLS), Zod (proposal payload contracts), Vitest (`npm test`), in-memory repositories for unit tests.

**Delta note:** This is a *delta against existing code*. The `Appointment` model + repos, the `DefaultAvailabilityFinder`, the proposal system (`ProposalType`, contracts, execution-handler registry), the `reschedule_appointment` / `cancel_appointment` handlers (already fully implemented — NOT stubs), the `CreateAppointmentAITaskHandler`, and the audit-event system all already exist. Every "Modify" below is against a real current file; every "Create" is genuinely new. The spec's §1 note that reschedule/cancel handlers are "stubs" is stale — they are real; this plan only *adds audit-event emission* to them.

---

## Resolved design decisions

These resolve open questions the spec (`docs/superpowers/specs/2026-05-14-serviceos-launch-readiness-design.md` §6) left for planning:

- **Held-slot expiry window: 24 hours.** A hold's `hold_expiry_at` is set to `now + 24h` at creation. There is **no background sweeper** — the availability finder treats an expired hold as free (so the slot is reusable immediately), and `CreateBookingExecutionHandler` refuses to confirm an expired hold. This is the minimum-credible release mechanism.
- **`hold_pending_approval` is a boolean flag, not a status value.** A held appointment has `status: 'scheduled'` plus `hold_pending_approval = true`. No change to the `AppointmentStatus` enum or its DB CHECK constraint. This matches the spec wording ("a `hold_pending_approval` flag") and avoids touching the status state machine.
- **Default buffer: 30 minutes.** The availability finder gains a `bufferMs` parameter (default `0` — backward compatible) and a `DEFAULT_BUFFER_MS = 30 * 60 * 1000` constant the held-slot booking path passes explicitly. A *per-tenant* buffer value is out of scope here — the onboarding plan (§10) will thread the real value through later.
- **`create_booking` action class: `capture`** — same as `create_appointment`. Whether it auto-approves is governed by the existing D-003 trust-tier machinery; the held slot sits on the calendar either way.

---

## File Structure

**Created:**
- `packages/api/src/proposals/execution/create-booking-handler.ts` — `CreateBookingExecutionHandler`: confirms a held appointment on proposal approval, emits `appointment.booked`.
- `packages/api/test/appointments/held-slot-fields.test.ts` — unit tests for the new model fields.
- `packages/api/test/proposals/create-booking-contract.test.ts` — unit tests for the new proposal type + contract.
- `packages/api/test/ai/availability-buffer.test.ts` — unit tests for buffer-aware availability + expired-hold handling.
- `packages/api/test/proposals/create-booking-handler.test.ts` — unit tests for `CreateBookingExecutionHandler`.
- `packages/api/test/proposals/reject-releases-hold.test.ts` — unit tests for reject-releases-hold.
- `packages/api/test/proposals/schedule-mutation-events.test.ts` — unit tests for reschedule/cancel audit events.
- `packages/api/test/ai/held-slot-booking-task.test.ts` — unit tests for the voice-agent held-slot path.

**Modified:**
- `packages/api/src/db/schema.ts` — new migration adding `hold_pending_approval` + `hold_expiry_at` columns.
- `packages/api/src/appointments/appointment.ts` — add the two fields to `Appointment` / `CreateAppointmentInput` / `UpdateAppointmentInput`; `createAppointment()` sets them.
- `packages/api/src/appointments/pg-appointment.ts` — `mapRow`, `create()` INSERT, and `update()` field-map gain the two columns.
- `packages/api/src/proposals/proposal.ts` — add `create_booking` to `ProposalType` + `VALID_PROPOSAL_TYPES` + `actionClassForProposalType()`.
- `packages/api/src/proposals/contracts.ts` — add `createBookingPayloadSchema` + register it in `PROPOSAL_TYPE_SCHEMAS`.
- `packages/api/src/ai/tasks/availability-finder.ts` — `bufferMs` param, busy-interval padding, expired-hold filtering, `DEFAULT_BUFFER_MS`.
- `packages/api/src/ai/skills/lookup-availability.ts` — thread `bufferMs` through.
- `packages/api/src/proposals/execution/handlers.ts` — register `CreateBookingExecutionHandler`; add `auditRepo` to the registry deps; pass `auditRepo` to reschedule/cancel handlers.
- `packages/api/src/proposals/execution/reschedule-handler.ts` — emit `appointment.rescheduled` audit event.
- `packages/api/src/proposals/execution/cancellation-handler.ts` — emit `appointment.canceled` audit event.
- `packages/api/src/proposals/actions.ts` — `rejectProposal` gains optional `appointmentRepo`; releases held slot for `create_booking`.
- `packages/api/src/routes/proposals.ts` — `createProposalsRouter` gains optional `appointmentRepo`, passed to `rejectProposal`.
- `packages/api/src/ai/tasks/create-appointment-task.ts` — `CreateAppointmentAITaskHandler` gains optional `appointmentRepo`; produces held appointment + `create_booking` proposal when wired.
- `packages/api/src/workers/voice-action-router.ts` — pass `appointmentRepo` into `CreateAppointmentAITaskHandler`.
- `packages/api/src/app.ts` — wire `auditRepo` into the execution-handler registry; wire `appointmentRepo` into `createProposalsRouter`; wire `appointmentRepo` into the voice-action-router deps.

**Commands** (run from `packages/api` unless noted):
- Single test file: `npm test -- test/path/to/file.test.ts`
- Full API test suite: `npm test`
- Production typecheck (the Railway build check, per `CLAUDE.md`): `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`

---

## Task 1: Held-slot fields on the Appointment model + migration

Adds `holdPendingApproval` + `holdExpiryAt` to the `Appointment` model end to end (TS interface, service functions, both repositories) and the DB migration. Both fields are **optional** on the `Appointment` interface so existing fixtures/constructors keep compiling; `createAppointment()` always sets `holdPendingApproval` explicitly.

**Files:**
- Modify: `packages/api/src/appointments/appointment.ts`
- Modify: `packages/api/src/appointments/pg-appointment.ts`
- Modify: `packages/api/src/db/schema.ts`
- Test: `packages/api/test/appointments/held-slot-fields.test.ts`

- [ ] **Step 1: Create the working branch from `main`**

The current branch (`feat/intake-form-completion`) is an open, unmerged PR — branch the new work from `main` so it doesn't stack the intake-form commits.

Run:
```bash
cd /Users/macmini/Serviceos/Serviceos
git checkout main && git pull origin main
git checkout -b feat/held-slot-scheduling
```
Expected: `Switched to a new branch 'feat/held-slot-scheduling'`

- [ ] **Step 2: Write the failing test**

Create `packages/api/test/appointments/held-slot-fields.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAppointment,
  updateAppointment,
} from '../../src/appointments/appointment';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';

const tenantA = '00000000-0000-4000-8000-00000000000a';

function baseInput() {
  return {
    tenantId: tenantA,
    jobId: '00000000-0000-4000-8000-0000000000j1',
    scheduledStart: new Date('2026-06-01T17:00:00Z'),
    scheduledEnd: new Date('2026-06-01T18:00:00Z'),
    timezone: 'America/Los_Angeles',
    createdBy: 'user-1',
  };
}

describe('held-slot appointment fields', () => {
  let repo: InMemoryAppointmentRepository;

  beforeEach(() => {
    repo = new InMemoryAppointmentRepository();
  });

  it('defaults holdPendingApproval to false when not provided', async () => {
    const appt = await createAppointment(baseInput(), repo);
    expect(appt.holdPendingApproval).toBe(false);
    expect(appt.holdExpiryAt).toBeUndefined();
  });

  it('persists holdPendingApproval + holdExpiryAt when provided', async () => {
    const expiry = new Date('2026-06-02T17:00:00Z');
    const appt = await createAppointment(
      { ...baseInput(), holdPendingApproval: true, holdExpiryAt: expiry },
      repo,
    );
    expect(appt.holdPendingApproval).toBe(true);
    expect(appt.holdExpiryAt).toEqual(expiry);

    const found = await repo.findById(tenantA, appt.id);
    expect(found?.holdPendingApproval).toBe(true);
    expect(found?.holdExpiryAt).toEqual(expiry);
  });

  it('updateAppointment can clear the hold flag', async () => {
    const appt = await createAppointment(
      { ...baseInput(), holdPendingApproval: true, holdExpiryAt: new Date('2026-06-02T17:00:00Z') },
      repo,
    );
    const updated = await updateAppointment(
      tenantA,
      appt.id,
      { holdPendingApproval: false },
      repo,
    );
    expect(updated?.holdPendingApproval).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/appointments/held-slot-fields.test.ts`
Expected: FAIL — TypeScript errors that `holdPendingApproval` / `holdExpiryAt` are not on `CreateAppointmentInput` / `UpdateAppointmentInput` / `Appointment`.

- [ ] **Step 4: Add the fields to the Appointment model**

In `packages/api/src/appointments/appointment.ts`:

In the `Appointment` interface, add these two fields immediately after the `status: AppointmentStatus;` line:
```typescript
  /**
   * When true, this appointment is a tentative AI-placed hold awaiting
   * owner approval. The slot is reserved on the calendar but not yet
   * confirmed. Cleared to false on approval; the appointment is
   * canceled on rejection.
   */
  holdPendingApproval?: boolean;
  /** When the tentative hold auto-releases if not approved (set when holdPendingApproval is true). */
  holdExpiryAt?: Date;
```

In the `CreateAppointmentInput` interface, add immediately after `createdBy: string;`:
```typescript
  /** Create the appointment as a tentative hold awaiting approval. Defaults to false. */
  holdPendingApproval?: boolean;
  /** When the tentative hold auto-releases. Set when holdPendingApproval is true. */
  holdExpiryAt?: Date;
```

In the `UpdateAppointmentInput` interface, add immediately after `status?: AppointmentStatus;`:
```typescript
  holdPendingApproval?: boolean;
  holdExpiryAt?: Date;
```

In the `createAppointment()` function, in the `const appointment: Appointment = { ... }` object literal, add immediately after the `status: 'scheduled',` line:
```typescript
    holdPendingApproval: input.holdPendingApproval ?? false,
    holdExpiryAt: input.holdExpiryAt,
```

> Note: the in-memory repository (`in-memory-appointment.ts`) needs **no change** — its `create()` does `{ ...appointment }` and `update()` does `{ ...a, ...updates }`, so the new fields flow through automatically.

- [ ] **Step 5: Add the fields to the Postgres repository**

First read `packages/api/src/appointments/pg-appointment.ts` in full so you can see the `create()` method's INSERT statement.

In `mapRow()`, add immediately after the `status: row.status as Appointment['status'],` line:
```typescript
    holdPendingApproval: (row.hold_pending_approval as boolean) ?? false,
    holdExpiryAt: row.hold_expiry_at ? new Date(row.hold_expiry_at as string) : undefined,
```

In the `update()` method's `fieldMap` object, add these two entries (alongside `status: 'status',`):
```typescript
        holdPendingApproval: 'hold_pending_approval',
        holdExpiryAt: 'hold_expiry_at',
```

In the `create()` method's INSERT statement: the method INSERTs the appointment row with an explicit column list and matching `$N` placeholders. Add `hold_pending_approval` and `hold_expiry_at` to the column list, add two more `$N` placeholders in the correct positions, and pass `appointment.holdPendingApproval ?? false` and `appointment.holdExpiryAt ?? null` as the corresponding values. Follow the exact pattern already used for the other columns in that method.

- [ ] **Step 6: Add the migration**

In `packages/api/src/db/schema.ts`, find the `MIGRATIONS` object. Determine the next migration number: check the highest numbered key in the `MIGRATIONS` object **and** the highest numbered file in `packages/api/src/db/migrations/*.sql`, and use the next integer after the highest of the two (this is expected to be `074`, but verify — do not collide). Add a new entry to the `MIGRATIONS` object using that number:
```typescript
  '074_add_held_appointment_fields': `
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS hold_pending_approval BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS hold_expiry_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_appointments_hold_expiry
      ON appointments(tenant_id, hold_expiry_at)
      WHERE hold_pending_approval = true;
  `,
```
(Adjust the `074_` prefix to the verified next number. The statements are all `IF NOT EXISTS` / idempotent, matching the convention — no constraint changes are needed because `hold_pending_approval` is a flag, not a status value.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/appointments/held-slot-fields.test.ts`
Expected: PASS — all 3 tests.

- [ ] **Step 8: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit 0. (Confirms the Pg repo changes and the optional-field additions compile cleanly against all existing callers.)

- [ ] **Step 9: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/appointments/appointment.ts packages/api/src/appointments/pg-appointment.ts packages/api/src/db/schema.ts packages/api/test/appointments/held-slot-fields.test.ts
git commit -m "feat(api): add held-slot fields to the appointment model"
```

---

## Task 2: The `create_booking` proposal type + contract

Registers a new proposal type end to end: the `ProposalType` union, the validation array, the action-class switch, and the Zod payload contract.

**Files:**
- Modify: `packages/api/src/proposals/proposal.ts`
- Modify: `packages/api/src/proposals/contracts.ts`
- Test: `packages/api/test/proposals/create-booking-contract.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/proposals/create-booking-contract.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { actionClassForProposalType, VALID_PROPOSAL_TYPES } from '../../src/proposals/proposal';

const validAppointmentId = '00000000-0000-4000-8000-0000000000a1';

describe('create_booking proposal type', () => {
  it('is a recognized proposal type', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('create_booking');
  });

  it('is classified as a capture-class action', () => {
    expect(actionClassForProposalType('create_booking')).toBe('capture');
  });

  it('accepts a payload with a valid appointmentId', () => {
    const result = validateProposalPayload('create_booking', {
      appointmentId: validAppointmentId,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload missing appointmentId', () => {
    const result = validateProposalPayload('create_booking', {});
    expect(result.valid).toBe(false);
  });

  it('rejects a payload with a non-uuid appointmentId', () => {
    const result = validateProposalPayload('create_booking', {
      appointmentId: 'not-a-uuid',
    });
    expect(result.valid).toBe(false);
  });
});
```

> Note: `VALID_PROPOSAL_TYPES` is currently declared `const` (not exported) in `proposal.ts`. Step 3 exports it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/proposals/create-booking-contract.test.ts`
Expected: FAIL — `VALID_PROPOSAL_TYPES` is not exported, `'create_booking'` is not a valid `ProposalType`, and there is no `create_booking` schema.

- [ ] **Step 3: Add `create_booking` to the proposal type**

In `packages/api/src/proposals/proposal.ts`:

In the `ProposalType` union type, add `'create_booking'` immediately after `'create_appointment'`:
```typescript
export type ProposalType = 'create_customer' | 'update_customer' | 'create_job' | 'create_appointment' | 'create_booking' | 'draft_estimate' | 'update_estimate' | 'draft_invoice' | 'update_invoice' | 'issue_invoice' | 'reassign_appointment' | 'reschedule_appointment' | 'cancel_appointment' | 'voice_clarification' | 'add_note' | 'send_invoice' | 'record_payment' | 'emergency_dispatch' | 'onboarding_tenant_settings' | 'onboarding_service_category' | 'onboarding_estimate_template' | 'onboarding_team_member' | 'onboarding_schedule';
```

Change the `VALID_PROPOSAL_TYPES` declaration from `const VALID_PROPOSAL_TYPES` to `export const VALID_PROPOSAL_TYPES` and add `'create_booking'` immediately after `'create_appointment'`:
```typescript
export const VALID_PROPOSAL_TYPES: ProposalType[] = [
  'create_customer',
  'update_customer',
  'create_job',
  'create_appointment',
  'create_booking',
  'draft_estimate',
  'update_estimate',
  'draft_invoice',
  'update_invoice',
  'issue_invoice',
  'reassign_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'voice_clarification',
  'add_note',
  'send_invoice',
  'record_payment',
  'emergency_dispatch',
  'onboarding_tenant_settings',
  'onboarding_service_category',
  'onboarding_estimate_template',
  'onboarding_team_member',
  'onboarding_schedule',
];
```

In the `actionClassForProposalType()` switch, add `case 'create_booking':` immediately above `case 'create_appointment':` so it falls through to `return 'capture';`:
```typescript
    case 'create_customer':
    case 'update_customer':
    case 'create_job':
    case 'create_appointment':
    case 'create_booking':
    case 'draft_estimate':
```

> `actionClassForProposalType` is an exhaustive switch with no `default` — TypeScript will fail to compile if `create_booking` is not handled, which is the safety net here.

- [ ] **Step 4: Add the `create_booking` payload contract**

In `packages/api/src/proposals/contracts.ts`:

Add the schema definition near the other `*PayloadSchema` exports (next to `createAppointmentPayloadSchema`):
```typescript
export const createBookingPayloadSchema = z.object({
  appointmentId: z.string().uuid(),
});
```

In the `PROPOSAL_TYPE_SCHEMAS` map, add the entry immediately after the `create_appointment:` line:
```typescript
  create_booking: createBookingPayloadSchema,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/proposals/create-booking-contract.test.ts`
Expected: PASS — all 5 tests.

- [ ] **Step 6: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit 0. (Confirms every exhaustive `ProposalType` switch in the codebase still compiles with the new member.)

- [ ] **Step 7: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/proposals/proposal.ts packages/api/src/proposals/contracts.ts packages/api/test/proposals/create-booking-contract.test.ts
git commit -m "feat(api): add create_booking proposal type and payload contract"
```

---

## Task 3: Buffer-aware availability + expired-hold handling

Teaches `DefaultAvailabilityFinder` two things: (1) pad busy intervals by a configurable `bufferMs` so it never offers a slot butted up against an existing appointment, and (2) treat an *expired* hold as free, so a hold the owner ignored releases its slot at read time.

**Files:**
- Modify: `packages/api/src/ai/tasks/availability-finder.ts`
- Modify: `packages/api/src/ai/skills/lookup-availability.ts`
- Test: `packages/api/test/ai/availability-buffer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/ai/availability-buffer.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DefaultAvailabilityFinder,
  DEFAULT_BUFFER_MS,
} from '../../src/ai/tasks/availability-finder';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../src/appointments/appointment';

const tenantA = '00000000-0000-4000-8000-00000000000a';
const HOUR = 60 * 60 * 1000;

function appt(overrides: Partial<Appointment>): Appointment {
  return {
    id: overrides.id ?? `appt-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: tenantA,
    jobId: 'job-1',
    scheduledStart: overrides.scheduledStart ?? new Date('2026-06-01T17:00:00Z'),
    scheduledEnd: overrides.scheduledEnd ?? new Date('2026-06-01T18:00:00Z'),
    timezone: 'UTC',
    status: overrides.status ?? 'scheduled',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    holdPendingApproval: overrides.holdPendingApproval,
    holdExpiryAt: overrides.holdExpiryAt,
  };
}

describe('buffer-aware availability', () => {
  let repo: InMemoryAppointmentRepository;
  let finder: DefaultAvailabilityFinder;

  beforeEach(() => {
    repo = new InMemoryAppointmentRepository();
    finder = new DefaultAvailabilityFinder({ appointmentRepo: repo });
  });

  it('exports a positive DEFAULT_BUFFER_MS', () => {
    expect(DEFAULT_BUFFER_MS).toBeGreaterThan(0);
  });

  it('does not offer a slot that starts within bufferMs of a busy appointment', async () => {
    // Busy 17:00–18:00. Without buffer, 18:00 is free. With a 30-min
    // buffer, the earliest offered slot must start at or after 18:30.
    await repo.create(appt({
      scheduledStart: new Date('2026-06-01T17:00:00Z'),
      scheduledEnd: new Date('2026-06-01T18:00:00Z'),
    }));

    const result = await finder.find({
      tenantId: tenantA,
      searchFrom: new Date('2026-06-01T18:00:00Z'),
      searchTo: new Date('2026-06-01T22:00:00Z'),
      durationMs: HOUR,
      bufferMs: 30 * 60 * 1000,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots[0].start.getTime()).toBeGreaterThanOrEqual(
        new Date('2026-06-01T18:30:00Z').getTime(),
      );
    }
  });

  it('treats an expired hold as free', async () => {
    // A held appointment 19:00–20:00 whose hold expired yesterday must
    // NOT block the 19:00 slot.
    await repo.create(appt({
      scheduledStart: new Date('2026-06-01T19:00:00Z'),
      scheduledEnd: new Date('2026-06-01T20:00:00Z'),
      holdPendingApproval: true,
      holdExpiryAt: new Date('2026-05-31T00:00:00Z'),
    }));

    const result = await finder.find({
      tenantId: tenantA,
      searchFrom: new Date('2026-06-01T19:00:00Z'),
      searchTo: new Date('2026-06-01T21:00:00Z'),
      durationMs: HOUR,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots[0].start.getTime()).toBe(
        new Date('2026-06-01T19:00:00Z').getTime(),
      );
    }
  });

  it('treats a non-expired hold as busy', async () => {
    // Same as above but the hold is still live — 19:00 must be blocked.
    await repo.create(appt({
      scheduledStart: new Date('2026-06-01T19:00:00Z'),
      scheduledEnd: new Date('2026-06-01T20:00:00Z'),
      holdPendingApproval: true,
      holdExpiryAt: new Date('2099-01-01T00:00:00Z'),
    }));

    const result = await finder.find({
      tenantId: tenantA,
      searchFrom: new Date('2026-06-01T19:00:00Z'),
      searchTo: new Date('2026-06-01T21:00:00Z'),
      durationMs: HOUR,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots[0].start.getTime()).toBe(
        new Date('2026-06-01T20:00:00Z').getTime(),
      );
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/ai/availability-buffer.test.ts`
Expected: FAIL — `DEFAULT_BUFFER_MS` is not exported, `bufferMs` is not a known input field, and the expired-hold test fails because expired holds currently still block.

- [ ] **Step 3: Add buffer + expired-hold handling to the finder**

In `packages/api/src/ai/tasks/availability-finder.ts`:

Add a `DEFAULT_BUFFER_MS` constant immediately after the existing `const DEFAULT_GRANULARITY_MS = 30 * 60 * 1000;` line:
```typescript
/**
 * Default gap enforced between a candidate slot and any existing
 * appointment, on both sides. Covers travel/setup time so the voice
 * agent never offers two jobs butted back-to-back. A per-tenant
 * override is threaded through in a later plan; callers that pass no
 * `bufferMs` get 0 (unchanged behavior).
 */
export const DEFAULT_BUFFER_MS = 30 * 60 * 1000;
```

In the `FindOpenSlotsInput` interface, add immediately after the `granularityMs?: number;` field:
```typescript
  /**
   * Gap (ms) to enforce on BOTH sides of every busy interval, so no
   * candidate slot touches an existing appointment. Defaults to 0
   * (no buffer) for backward compatibility.
   */
  bufferMs?: number;
```

In the `find()` method, replace the line that builds `blocking`:
```typescript
    let blocking = candidates.filter((a) => ACTIVE_APPOINTMENT_STATUSES.has(a.status));
```
with this version, which additionally drops expired holds:
```typescript
    const now = Date.now();
    let blocking = candidates.filter((a) => {
      if (!ACTIVE_APPOINTMENT_STATUSES.has(a.status)) return false;
      // An expired hold has released its slot — treat it as free. A
      // live hold (or a non-hold appointment) still blocks.
      if (a.holdPendingApproval && a.holdExpiryAt && a.holdExpiryAt.getTime() < now) {
        return false;
      }
      return true;
    });
```

In the `find()` method, replace the `const busy = mergeIntervals(...)` block:
```typescript
    const busy = mergeIntervals(
      blocking.map((a) => ({
        start: a.scheduledStart.getTime(),
        end: a.scheduledEnd.getTime(),
      })),
    );
```
with a version that pads each busy interval by `bufferMs`:
```typescript
    const bufferMs = Math.max(0, input.bufferMs ?? 0);
    const busy = mergeIntervals(
      blocking.map((a) => ({
        start: a.scheduledStart.getTime() - bufferMs,
        end: a.scheduledEnd.getTime() + bufferMs,
      })),
    );
```

- [ ] **Step 4: Thread `bufferMs` through the lookup skill**

In `packages/api/src/ai/skills/lookup-availability.ts`:

In the `LookupAvailabilityInput` interface, add immediately after the `count?: number;` field:
```typescript
  /** Gap (ms) to enforce around existing appointments. Forwarded to the finder. */
  bufferMs?: number;
```

In the `lookupAvailability()` function, in the `finder.find({ ... })` call, add `bufferMs: input.bufferMs,` immediately after the `count: input.count,` line.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/ai/availability-buffer.test.ts`
Expected: PASS — all 4 tests.

- [ ] **Step 6: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit 0.

- [ ] **Step 7: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/tasks/availability-finder.ts packages/api/src/ai/skills/lookup-availability.ts packages/api/test/ai/availability-buffer.test.ts
git commit -m "feat(api): buffer-aware availability + release expired holds at read time"
```

---

## Task 4: `CreateBookingExecutionHandler`

The execution handler that runs when a `create_booking` proposal is approved: it confirms the held appointment (clears `holdPendingApproval`) and emits an `appointment.booked` audit event. Idempotent, and refuses to confirm an expired hold.

**Files:**
- Create: `packages/api/src/proposals/execution/create-booking-handler.ts`
- Modify: `packages/api/src/proposals/execution/handlers.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/test/proposals/create-booking-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/proposals/create-booking-handler.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { CreateBookingExecutionHandler } from '../../src/proposals/execution/create-booking-handler';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createAppointment } from '../../src/appointments/appointment';
import { createProposal } from '../../src/proposals/proposal';

const tenantA = '00000000-0000-4000-8000-00000000000a';

function bookingProposal(appointmentId: string) {
  return createProposal({
    tenantId: tenantA,
    proposalType: 'create_booking',
    payload: { appointmentId },
    summary: 'Book the held slot',
    createdBy: 'agent-1',
  });
}

async function makeHeldAppointment(
  repo: InMemoryAppointmentRepository,
  holdExpiryAt: Date,
) {
  return createAppointment(
    {
      tenantId: tenantA,
      jobId: '00000000-0000-4000-8000-0000000000j1',
      scheduledStart: new Date('2026-06-01T17:00:00Z'),
      scheduledEnd: new Date('2026-06-01T18:00:00Z'),
      timezone: 'UTC',
      createdBy: 'agent-1',
      holdPendingApproval: true,
      holdExpiryAt,
    },
    repo,
  );
}

describe('CreateBookingExecutionHandler', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let auditRepo: InMemoryAuditRepository;
  let handler: CreateBookingExecutionHandler;

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    auditRepo = new InMemoryAuditRepository();
    handler = new CreateBookingExecutionHandler(appointmentRepo, auditRepo);
  });

  it('has the create_booking proposal type', () => {
    expect(handler.proposalType).toBe('create_booking');
  });

  it('confirms a live held appointment and emits appointment.booked', async () => {
    const appt = await makeHeldAppointment(appointmentRepo, new Date('2099-01-01T00:00:00Z'));
    const result = await handler.execute(bookingProposal(appt.id), {
      tenantId: tenantA,
      executedBy: 'owner-1',
    });

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(appt.id);

    const confirmed = await appointmentRepo.findById(tenantA, appt.id);
    expect(confirmed?.holdPendingApproval).toBe(false);

    const events = await auditRepo.findByEntity(tenantA, 'appointment', appt.id);
    expect(events.some((e) => e.eventType === 'appointment.booked')).toBe(true);
  });

  it('is idempotent — an already-confirmed appointment still succeeds', async () => {
    const appt = await makeHeldAppointment(appointmentRepo, new Date('2099-01-01T00:00:00Z'));
    const proposal = bookingProposal(appt.id);
    await handler.execute(proposal, { tenantId: tenantA, executedBy: 'owner-1' });
    const second = await handler.execute(proposal, { tenantId: tenantA, executedBy: 'owner-1' });
    expect(second.success).toBe(true);
  });

  it('fails when the hold has expired', async () => {
    const appt = await makeHeldAppointment(appointmentRepo, new Date('2020-01-01T00:00:00Z'));
    const result = await handler.execute(bookingProposal(appt.id), {
      tenantId: tenantA,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });

  it('fails when the appointment does not exist', async () => {
    const result = await handler.execute(
      bookingProposal('00000000-0000-4000-8000-0000000000zz'),
      { tenantId: tenantA, executedBy: 'owner-1' },
    );
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/proposals/create-booking-handler.test.ts`
Expected: FAIL — `Failed to resolve import` (the handler file does not exist yet).

- [ ] **Step 3: Create the handler**

Create `packages/api/src/proposals/execution/create-booking-handler.ts`:
```typescript
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository, updateAppointment } from '../../appointments/appointment';
import { AuditRepository, createAuditEvent } from '../../audit/audit';

/**
 * Confirms a tentative held appointment when its `create_booking`
 * proposal is approved. The held appointment was created up front by
 * the voice agent (so the slot is reserved on the calendar); this
 * handler just clears the `holdPendingApproval` flag and emits an
 * `appointment.booked` audit event for the customer-communications
 * subsystem to act on.
 *
 * Degrades to a synthetic-id passthrough when no appointmentRepo is
 * wired — consistent with the other in-registry handlers used by
 * in-memory tests that don't exercise the mutation path.
 */
export class CreateBookingExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_booking';

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    const appointmentId = payload.appointmentId;
    if (!appointmentId || typeof appointmentId !== 'string') {
      return { success: false, error: 'Payload must include a valid appointmentId' };
    }

    if (!this.appointmentRepo) {
      return { success: true, resultEntityId: appointmentId };
    }

    const appointment = await this.appointmentRepo.findById(context.tenantId, appointmentId);
    if (!appointment) {
      return { success: false, error: `Appointment ${appointmentId} not found` };
    }

    // Idempotency: a non-held appointment is already confirmed.
    if (!appointment.holdPendingApproval) {
      return { success: true, resultEntityId: appointmentId };
    }

    // A hold that expired before approval cannot be confirmed — its
    // slot was already released back into availability.
    if (appointment.holdExpiryAt && appointment.holdExpiryAt.getTime() < Date.now()) {
      return {
        success: false,
        error: `Hold on appointment ${appointmentId} has expired — re-book the slot`,
      };
    }

    const updated = await updateAppointment(
      context.tenantId,
      appointmentId,
      { holdPendingApproval: false },
      this.appointmentRepo,
    );
    if (!updated) {
      return { success: false, error: 'Failed to confirm held appointment' };
    }

    if (this.auditRepo) {
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: 'system',
          eventType: 'appointment.booked',
          entityType: 'appointment',
          entityId: appointmentId,
          metadata: { proposalId: proposal.id, jobId: appointment.jobId },
        }),
      );
    }

    return { success: true, resultEntityId: appointmentId };
  }
}
```

- [ ] **Step 4: Register the handler + wire `auditRepo`**

In `packages/api/src/proposals/execution/handlers.ts`:

Add the import alongside the other handler imports near the top of the file:
```typescript
import { CreateBookingExecutionHandler } from './create-booking-handler';
import { AuditRepository } from '../../audit/audit';
```

In `createExecutionHandlerRegistry()`, add `auditRepo?: AuditRepository;` to the `deps` parameter object type (alongside `analyticsRepo?: DispatchAnalyticsRepository;`).

In the `handlers` array inside `createExecutionHandlerRegistry()`, add this entry immediately after the `new CreateAppointmentExecutionHandler(...)` line:
```typescript
    new CreateBookingExecutionHandler(deps?.appointmentRepo, deps?.auditRepo),
```

- [ ] **Step 5: Wire `auditRepo` into the registry call in `app.ts`**

In `packages/api/src/app.ts`, find the `createExecutionHandlerRegistry({ ... })` call. Add `auditRepo,` to the deps object (the `auditRepo` variable already exists in scope — it is assigned earlier in the same function: `const auditRepo = webhookAuditRepo;`). The call becomes:
```typescript
const executionHandlers = createExecutionHandlerRegistry({
  appointmentRepo,
  assignmentRepo,
  invoiceRepo,
  estimateRepo,
  settingsRepo,
  noteRepo,
  paymentRepo,
  invoiceDeliveryProvider,
  analyticsRepo: dispatchAnalyticsRepo,
  schedulingNotifier: schedulingConfirmationNotifier,
  auditRepo,
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/proposals/create-booking-handler.test.ts`
Expected: PASS — all 5 tests.

- [ ] **Step 7: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit 0.

- [ ] **Step 8: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/proposals/execution/create-booking-handler.ts packages/api/src/proposals/execution/handlers.ts packages/api/src/app.ts packages/api/test/proposals/create-booking-handler.test.ts
git commit -m "feat(api): add CreateBookingExecutionHandler to confirm held slots"
```

---

## Task 5: Reject-releases-hold

When a `create_booking` proposal is rejected, the tentative held appointment must be released (canceled). This extends `rejectProposal` with an optional `appointmentRepo` and threads it through the proposals router.

**Files:**
- Modify: `packages/api/src/proposals/actions.ts`
- Modify: `packages/api/src/routes/proposals.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/test/proposals/reject-releases-hold.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/proposals/reject-releases-hold.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { rejectProposal } from '../../src/proposals/actions';
import { createProposal } from '../../src/proposals/proposal';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { createAppointment } from '../../src/appointments/appointment';

const tenantA = '00000000-0000-4000-8000-00000000000a';

async function heldAppointment(repo: InMemoryAppointmentRepository) {
  return createAppointment(
    {
      tenantId: tenantA,
      jobId: '00000000-0000-4000-8000-0000000000j1',
      scheduledStart: new Date('2026-06-01T17:00:00Z'),
      scheduledEnd: new Date('2026-06-01T18:00:00Z'),
      timezone: 'UTC',
      createdBy: 'agent-1',
      holdPendingApproval: true,
      holdExpiryAt: new Date('2099-01-01T00:00:00Z'),
    },
    repo,
  );
}

describe('rejectProposal releases held slots', () => {
  let proposalRepo: InMemoryProposalRepository;
  let appointmentRepo: InMemoryAppointmentRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
  });

  it('cancels the held appointment when a create_booking proposal is rejected', async () => {
    const appt = await heldAppointment(appointmentRepo);
    const proposal = await proposalRepo.create(
      createProposal({
        tenantId: tenantA,
        proposalType: 'create_booking',
        payload: { appointmentId: appt.id },
        summary: 'Book the held slot',
        createdBy: 'agent-1',
      }),
    );

    await rejectProposal(
      proposalRepo,
      tenantA,
      proposal.id,
      'owner-1',
      'owner',
      'changed_mind',
      undefined,
      appointmentRepo,
    );

    const released = await appointmentRepo.findById(tenantA, appt.id);
    expect(released?.status).toBe('canceled');
    expect(released?.holdPendingApproval).toBe(false);
  });

  it('leaves appointments untouched when a non-booking proposal is rejected', async () => {
    const appt = await heldAppointment(appointmentRepo);
    const proposal = await proposalRepo.create(
      createProposal({
        tenantId: tenantA,
        proposalType: 'add_note',
        payload: { entityType: 'job', entityId: 'job-1', body: 'note' },
        summary: 'Add a note',
        createdBy: 'agent-1',
      }),
    );

    await rejectProposal(
      proposalRepo,
      tenantA,
      proposal.id,
      'owner-1',
      'owner',
      'not_needed',
      undefined,
      appointmentRepo,
    );

    const untouched = await appointmentRepo.findById(tenantA, appt.id);
    expect(untouched?.status).toBe('scheduled');
  });
});
```

> If `InMemoryProposalRepository` is not exported from `proposal.ts`, read `packages/api/src/proposals/proposal.ts` to find the correct in-memory proposal repository export and import path, and adjust the import — the rest of the test is unaffected.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/proposals/reject-releases-hold.test.ts`
Expected: FAIL — `rejectProposal` does not accept an 8th `appointmentRepo` argument.

- [ ] **Step 3: Extend `rejectProposal`**

In `packages/api/src/proposals/actions.ts`:

Add the import alongside the existing imports at the top of the file:
```typescript
import { AppointmentRepository, updateAppointment } from '../appointments/appointment';
```

Change the `rejectProposal` signature to accept an optional `appointmentRepo` as a final parameter:
```typescript
export async function rejectProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  reason: string,
  details?: string,
  appointmentRepo?: AppointmentRepository
): Promise<Proposal> {
```

In the body of `rejectProposal`, immediately before the final `return updated;`, add the hold-release logic:
```typescript
  // Releasing the held slot: a rejected create_booking proposal means
  // the owner declined the AI's tentative hold — cancel the held
  // appointment so the calendar slot frees up. Best-effort: a missing
  // appointmentRepo or a non-string appointmentId is simply skipped.
  if (
    appointmentRepo &&
    updated.proposalType === 'create_booking' &&
    typeof updated.payload.appointmentId === 'string'
  ) {
    await updateAppointment(
      tenantId,
      updated.payload.appointmentId,
      { status: 'canceled', holdPendingApproval: false },
      appointmentRepo,
    );
  }
```

- [ ] **Step 4: Thread `appointmentRepo` through the proposals router**

In `packages/api/src/routes/proposals.ts`:

Change the `createProposalsRouter` factory signature to accept an optional `appointmentRepo`:
```typescript
export function createProposalsRouter(
  proposalRepo: ProposalRepository,
  appointmentRepo?: AppointmentRepository,
): Router {
```
Add the import for `AppointmentRepository` alongside the existing imports at the top of the file:
```typescript
import { AppointmentRepository } from '../appointments/appointment';
```

In the `POST /:id/reject` route handler, change the `rejectProposal(...)` call to pass `appointmentRepo` as the final argument:
```typescript
        const result = await rejectProposal(
          proposalRepo,
          req.auth!.tenantId,
          req.params.id,
          req.auth!.userId,
          req.auth!.role as Role,
          parsed.reason,
          parsed.details,
          appointmentRepo
        );
```

- [ ] **Step 5: Wire `appointmentRepo` into the router mount in `app.ts`**

In `packages/api/src/app.ts`, find the proposals router mount and change it from:
```typescript
  app.use('/api/proposals', createProposalsRouter(proposalRepo));
```
to:
```typescript
  app.use('/api/proposals', createProposalsRouter(proposalRepo, appointmentRepo));
```
(`appointmentRepo` already exists in scope — it is assigned earlier in the same function.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/proposals/reject-releases-hold.test.ts`
Expected: PASS — both tests.

- [ ] **Step 7: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit 0. (Confirms every other caller of `rejectProposal` still compiles — the new parameter is optional.)

- [ ] **Step 8: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/proposals/actions.ts packages/api/src/routes/proposals.ts packages/api/src/app.ts packages/api/test/proposals/reject-releases-hold.test.ts
git commit -m "feat(api): release the held slot when a create_booking proposal is rejected"
```

---

## Task 6: Schedule-mutation audit events on reschedule + cancel

The `reschedule_appointment` and `cancel_appointment` execution handlers already emit *dispatch-analytics* events, but the customer-communications subsystem (a later plan) needs a consistent `appointment.*` **audit** event stream. This adds `appointment.rescheduled` and `appointment.canceled` audit events alongside the existing analytics events. (`appointment.booked` is already emitted by `CreateBookingExecutionHandler` from Task 4.)

**Files:**
- Modify: `packages/api/src/proposals/execution/reschedule-handler.ts`
- Modify: `packages/api/src/proposals/execution/cancellation-handler.ts`
- Modify: `packages/api/src/proposals/execution/handlers.ts`
- Test: `packages/api/test/proposals/schedule-mutation-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/proposals/schedule-mutation-events.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { RescheduleAppointmentExecutionHandler } from '../../src/proposals/execution/reschedule-handler';
import { CancelAppointmentExecutionHandler } from '../../src/proposals/execution/cancellation-handler';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createAppointment } from '../../src/appointments/appointment';
import { createProposal } from '../../src/proposals/proposal';

const tenantA = '00000000-0000-4000-8000-00000000000a';

async function scheduledAppointment(repo: InMemoryAppointmentRepository) {
  return createAppointment(
    {
      tenantId: tenantA,
      jobId: '00000000-0000-4000-8000-0000000000j1',
      scheduledStart: new Date('2026-06-01T17:00:00Z'),
      scheduledEnd: new Date('2026-06-01T18:00:00Z'),
      timezone: 'UTC',
      createdBy: 'agent-1',
    },
    repo,
  );
}

describe('schedule-mutation audit events', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('reschedule handler emits an appointment.rescheduled audit event', async () => {
    const appt = await scheduledAppointment(appointmentRepo);
    const handler = new RescheduleAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      undefined,
      auditRepo,
    );
    const proposal = createProposal({
      tenantId: tenantA,
      proposalType: 'reschedule_appointment',
      payload: {
        appointmentId: appt.id,
        newScheduledStart: '2026-06-02T17:00:00Z',
        newScheduledEnd: '2026-06-02T18:00:00Z',
      },
      summary: 'Reschedule',
      createdBy: 'agent-1',
    });

    const result = await handler.execute(proposal, { tenantId: tenantA, executedBy: 'owner-1' });
    expect(result.success).toBe(true);

    const events = await auditRepo.findByEntity(tenantA, 'appointment', appt.id);
    expect(events.some((e) => e.eventType === 'appointment.rescheduled')).toBe(true);
  });

  it('cancel handler emits an appointment.canceled audit event', async () => {
    const appt = await scheduledAppointment(appointmentRepo);
    const handler = new CancelAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      auditRepo,
    );
    const proposal = createProposal({
      tenantId: tenantA,
      proposalType: 'cancel_appointment',
      payload: {
        appointmentId: appt.id,
        reason: 'customer_request',
        cancellationType: 'customer_request',
      },
      summary: 'Cancel',
      createdBy: 'agent-1',
    });

    const result = await handler.execute(proposal, { tenantId: tenantA, executedBy: 'owner-1' });
    expect(result.success).toBe(true);

    const events = await auditRepo.findByEntity(tenantA, 'appointment', appt.id);
    expect(events.some((e) => e.eventType === 'appointment.canceled')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/proposals/schedule-mutation-events.test.ts`
Expected: FAIL — neither handler constructor accepts an `auditRepo` parameter, and no audit events are emitted.

- [ ] **Step 3: Add audit emission to the reschedule handler**

In `packages/api/src/proposals/execution/reschedule-handler.ts`:

Add the import alongside the existing imports at the top of the file:
```typescript
import { AuditRepository, createAuditEvent } from '../../audit/audit';
```

Add a 4th constructor parameter `auditRepo`:
```typescript
  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly assignmentRepo?: AssignmentRepository,
    private readonly analyticsRepo?: DispatchAnalyticsRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}
```

In the `execute()` method, immediately after the existing `if (this.analyticsRepo) { await captureDispatchEvent(...) }` block and before the `return { success: true, resultEntityId: appointmentId };` line, add:
```typescript
      if (this.auditRepo) {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'system',
            eventType: 'appointment.rescheduled',
            entityType: 'appointment',
            entityId: appointmentId,
            metadata: { proposalId: proposal.id, newScheduledStart, newScheduledEnd },
          }),
        );
      }
```

- [ ] **Step 4: Add audit emission to the cancellation handler**

In `packages/api/src/proposals/execution/cancellation-handler.ts`:

Add the import alongside the existing imports at the top of the file:
```typescript
import { AuditRepository, createAuditEvent } from '../../audit/audit';
```

Add a 3rd constructor parameter `auditRepo`:
```typescript
  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly analyticsRepo?: DispatchAnalyticsRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}
```

In the `execute()` method, immediately after the existing `if (this.analyticsRepo) { await captureDispatchEvent(...) }` block and before the final `return { success: true, resultEntityId: appointmentId };`, add:
```typescript
      if (this.auditRepo) {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'system',
            eventType: 'appointment.canceled',
            entityType: 'appointment',
            entityId: appointmentId,
            metadata: { proposalId: proposal.id, reason },
          }),
        );
      }
```

- [ ] **Step 5: Pass `auditRepo` to both handlers in the registry**

In `packages/api/src/proposals/execution/handlers.ts`, in `createExecutionHandlerRegistry()`, update the two handler constructions in the `handlers` array to pass `deps?.auditRepo`:
```typescript
    new RescheduleAppointmentExecutionHandler(deps?.appointmentRepo, deps?.assignmentRepo, deps?.analyticsRepo, deps?.auditRepo),
    new CancelAppointmentExecutionHandler(deps?.appointmentRepo, deps?.analyticsRepo, deps?.auditRepo),
```

> The `auditRepo` key was already added to the registry's `deps` type and wired in `app.ts` in Task 4 — no further `app.ts` change is needed here.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/proposals/schedule-mutation-events.test.ts`
Expected: PASS — both tests.

- [ ] **Step 7: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit 0.

- [ ] **Step 8: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/proposals/execution/reschedule-handler.ts packages/api/src/proposals/execution/cancellation-handler.ts packages/api/src/proposals/execution/handlers.ts packages/api/test/proposals/schedule-mutation-events.test.ts
git commit -m "feat(api): emit appointment.rescheduled / appointment.canceled audit events"
```

---

## Task 7: Voice-agent held-slot booking

Wires it all together: when the inbound voice agent's `CreateAppointmentAITaskHandler` is constructed with an `appointmentRepo` and the LLM produced a complete booking (`jobId` + start + end), it creates the held appointment up front and emits a `create_booking` proposal referencing it — instead of the legacy `create_appointment` proposal. Without an `appointmentRepo` (programmatic callers, in-memory tests), behavior is unchanged.

**Files:**
- Modify: `packages/api/src/ai/tasks/create-appointment-task.ts`
- Modify: `packages/api/src/workers/voice-action-router.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/test/ai/held-slot-booking-task.test.ts`

- [ ] **Step 1: Read the surrounding code**

Before editing, read these three files in full so the wiring is exact:
- `packages/api/src/ai/tasks/create-appointment-task.ts` (the handler — verbatim reference for `handle()` is in this plan's source, but read the live file).
- `packages/api/src/workers/voice-action-router.ts` — find the `VoiceActionRouterDeps` interface and the `buildHandlers()` function. Confirm whether `VoiceActionRouterDeps` already has an `appointmentRepo` field; if not, you will add one.
- `packages/api/src/ai/tasks/task-handlers.ts` — confirm the `TaskContext` and `TaskResult` shapes (the handler returns `{ proposal, taskType }`).

- [ ] **Step 2: Write the failing test**

Create `packages/api/test/ai/held-slot-booking-task.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { CreateAppointmentAITaskHandler } from '../../src/ai/tasks/create-appointment-task';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';

const tenantA = '00000000-0000-4000-8000-00000000000a';
const jobId = '00000000-0000-4000-8000-0000000000j1';

/** Minimal fake gateway that returns a fixed JSON booking. */
function fakeGateway(json: Record<string, unknown>): LLMGateway {
  return {
    complete: async () => ({ content: JSON.stringify(json) }),
  } as unknown as LLMGateway;
}

function context(): TaskContext {
  return {
    tenantId: tenantA,
    userId: 'agent-1',
    message: 'Book the Johnson AC repair next Tuesday at 2pm',
  } as TaskContext;
}

const completeBooking = {
  jobId,
  scheduledStart: '2026-06-02T21:00:00Z',
  scheduledEnd: '2026-06-02T22:00:00Z',
  summary: 'AC repair',
  confidence_score: 0.9,
};

describe('CreateAppointmentAITaskHandler — held-slot booking', () => {
  let appointmentRepo: InMemoryAppointmentRepository;

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
  });

  it('creates a held appointment and a create_booking proposal when wired with an appointmentRepo', async () => {
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway(completeBooking),
      undefined,
      undefined,
      appointmentRepo,
    );

    const result = await handler.handle(context());

    expect(result.taskType).toBe('create_booking');
    expect(result.proposal.proposalType).toBe('create_booking');

    const appointmentId = result.proposal.payload.appointmentId as string;
    expect(typeof appointmentId).toBe('string');

    const held = await appointmentRepo.findById(tenantA, appointmentId);
    expect(held).not.toBeNull();
    expect(held?.holdPendingApproval).toBe(true);
    expect(held?.holdExpiryAt).toBeInstanceOf(Date);
    expect(held?.jobId).toBe(jobId);
  });

  it('falls back to a create_appointment proposal when no appointmentRepo is wired', async () => {
    const handler = new CreateAppointmentAITaskHandler(fakeGateway(completeBooking));
    const result = await handler.handle(context());
    expect(result.taskType).toBe('create_appointment');
    expect(result.proposal.proposalType).toBe('create_appointment');
  });

  it('falls back to create_appointment when the LLM did not produce a jobId', async () => {
    const handler = new CreateAppointmentAITaskHandler(
      fakeGateway({ ...completeBooking, jobId: undefined }),
      undefined,
      undefined,
      appointmentRepo,
    );
    const result = await handler.handle(context());
    expect(result.proposal.proposalType).toBe('create_appointment');
  });
});
```

> If the live `LLMGateway` or `TaskContext` shapes differ from the casts above, adjust the fake to satisfy the real interface — the test's intent (a fixed JSON response, a minimal context) is what matters.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/ai/held-slot-booking-task.test.ts`
Expected: FAIL — `CreateAppointmentAITaskHandler`'s constructor does not accept a 4th `appointmentRepo` argument; it always returns a `create_appointment` proposal.

- [ ] **Step 4: Add the held-slot path to the task handler**

In `packages/api/src/ai/tasks/create-appointment-task.ts`:

Add the import alongside the existing imports at the top of the file:
```typescript
import { AppointmentRepository, createAppointment } from '../../appointments/appointment';
```

Add a `HOLD_WINDOW_MS` constant near the other top-level constants (e.g. after `ISO_DATETIME_REGEX`):
```typescript
/** A tentative hold survives 24h before the availability finder treats it as free. */
const HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;
```

Add a 4th constructor parameter `appointmentRepo` and store it:
```typescript
  private readonly slotConflictChecker?: SlotConflictChecker;
  private readonly availabilityFinder?: AvailabilityFinder;
  private readonly appointmentRepo?: AppointmentRepository;

  constructor(
    gateway: LLMGateway,
    slotConflictChecker?: SlotConflictChecker,
    availabilityFinder?: AvailabilityFinder,
    appointmentRepo?: AppointmentRepository
  ) {
    this.gateway = gateway;
    this.slotConflictChecker = slotConflictChecker;
    this.availabilityFinder = availabilityFinder;
    this.appointmentRepo = appointmentRepo;
  }
```

In the `handle()` method, the existing code builds `const input: CreateProposalInput = { ... }` and then ends with `return { proposal: createProposal(input), taskType: this.taskType };`. Leave the `input` object exactly as it is — it is the `create_appointment` fallback path. Insert this held-slot branch **immediately before** that existing `return { proposal: createProposal(input), taskType: this.taskType };` line:
```typescript
    // Held-slot booking path: when an appointmentRepo is wired AND the
    // LLM produced a complete booking (jobId + both timestamps), place
    // a tentative hold on the calendar up front and emit a
    // `create_booking` proposal that references it. The slot is
    // reserved immediately; approving the proposal confirms it,
    // rejecting it releases it. Without a repo, or with an incomplete
    // booking, fall through to the legacy create_appointment proposal.
    const repo = this.appointmentRepo;
    if (repo && typeof payload.jobId === 'string' && scheduledStart && scheduledEnd) {
      const held = await createAppointment(
        {
          tenantId: context.tenantId,
          jobId: payload.jobId,
          scheduledStart: new Date(scheduledStart),
          scheduledEnd: new Date(scheduledEnd),
          timezone: 'UTC',
          notes: typeof payload.summary === 'string' ? payload.summary : undefined,
          createdBy: context.userId,
          holdPendingApproval: true,
          holdExpiryAt: new Date(Date.now() + HOLD_WINDOW_MS),
        },
        repo,
      );
      const bookingInput: CreateProposalInput = {
        tenantId: context.tenantId,
        proposalType: 'create_booking',
        payload: { appointmentId: held.id },
        summary: context.message,
        confidenceScore: confidence.score,
        confidenceFactors: confidence.factors,
        sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
        createdBy: context.userId,
        sourceTrustTier: 'autonomous',
        ...(context.tenantThresholdOverride
          ? { tenantThresholdOverride: context.tenantThresholdOverride }
          : {}),
      };
      return { proposal: createProposal(bookingInput), taskType: 'create_booking' };
    }
```

> `scheduledStart` and `scheduledEnd` are already-declared `string | undefined` locals from the existing conflict-check block above. `typeof payload.jobId === 'string'` narrows `payload.jobId` (an `unknown`) so it can be passed directly with no cast.

- [ ] **Step 5: Wire `appointmentRepo` into the voice-action-router**

In `packages/api/src/workers/voice-action-router.ts`:

If `VoiceActionRouterDeps` does not already have an `appointmentRepo` field, add one:
```typescript
  /** When provided, the create_appointment handler produces held-slot bookings. */
  appointmentRepo?: AppointmentRepository;
```
and add the import for `AppointmentRepository` from `../appointments/appointment` alongside the existing imports.

In `buildHandlers()`, update the `CreateAppointmentAITaskHandler` construction to pass `deps.appointmentRepo`:
```typescript
  handlers.set(
    'create_appointment',
    new CreateAppointmentAITaskHandler(
      deps.gateway,
      deps.slotConflictChecker,
      deps.availabilityFinder,
      deps.appointmentRepo,
    ),
  );
```

- [ ] **Step 6: Wire `appointmentRepo` into the voice-action-router deps in `app.ts`**

In `packages/api/src/app.ts`, find where the `voice-action-router` worker / its deps object is constructed (search for `VoiceActionRouterDeps`, `voice-action-router`, or the `availabilityFinder` being passed into the voice worker). Add `appointmentRepo,` to that deps object (`appointmentRepo` is already in scope). If the voice-action-router is wired through a different construction site than expected, add `appointmentRepo` to whichever deps object is passed into `buildHandlers()` / the router.

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/ai/held-slot-booking-task.test.ts`
Expected: PASS — all 3 tests.

- [ ] **Step 8: Run the full API test suite + production typecheck**

Run: `cd packages/api && npm test`
Expected: PASS — no regressions. (Pre-existing unrelated failures, if any, are out of scope — but nothing this plan touched should fail.)

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit 0.

- [ ] **Step 9: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/tasks/create-appointment-task.ts packages/api/src/workers/voice-action-router.ts packages/api/src/app.ts packages/api/test/ai/held-slot-booking-task.test.ts
git commit -m "feat(api): inbound voice agent places held-slot bookings via create_booking"
```

---

## Self-Review

**1. Spec coverage** — checked against `2026-05-14-serviceos-launch-readiness-design.md` §1 + §5:
- *§5 "held slots first-class: a `hold_pending_approval` flag"* → Task 1 (model + migration). ✅
- *§5 "cleared on approval"* → Task 4 (`CreateBookingExecutionHandler` clears the flag). ✅
- *§5 "released on rejection"* → Task 5 (reject-releases-hold). ✅
- *§5 "buffer-aware availability (a default buffer between jobs)"* → Task 3. ✅
- *§5 "every schedule mutation emits an event for Section 7"* → Task 4 (`appointment.booked`) + Task 6 (`appointment.rescheduled` / `appointment.canceled`). ✅
- *§5 "reschedule and cancel are themselves proposals"* → already true in the codebase; Task 6 only adds audit events to the existing handlers. ✅ (The spec's "stub" note was stale — called out in the Delta note.)
- *§1 "places a tentative hold on a real calendar slot"* → Task 7 (voice agent creates the held appointment up front). ✅
- *§1 "the booking becomes a `CreateBooking` proposal"* → Task 2 (`create_booking` type) + Task 7 (handler emits it). ✅
- *§1 "Approving confirms the slot; rejecting releases it"* → Task 4 + Task 5. ✅
- *Open question "held-slot expiry window"* → resolved (24h, read-time release) in the Resolved design decisions section + implemented in Tasks 1/3/4. ✅
- Held-slot expiry sweeper (background worker) is **intentionally out of scope** — the read-time release in Task 3 + the expiry check in Task 4 are the minimum-credible mechanism; a sweeper can be a later follow-up.

**2. Placeholder scan** — every code step has complete, copy-pasteable code. Two spots instruct "read the file first" (Task 1 Step 5's Pg `create()` INSERT, Task 7 Step 1) — these are precise mechanical edits against a visible pattern, not placeholders, and are flagged explicitly. Task 7 Step 4 contains an explicit correction note pinning the exact guard line. No "TBD" / "handle errors appropriately" / "similar to Task N".

**3. Type consistency** — verified across tasks:
- `holdPendingApproval` / `holdExpiryAt` — defined on `Appointment` (optional), `CreateAppointmentInput`, `UpdateAppointmentInput` in Task 1; consumed in Tasks 3 (finder), 4 (handler), 5 (reject), 7 (task handler). Names consistent throughout.
- `create_booking` — added to `ProposalType` + `VALID_PROPOSAL_TYPES` + `actionClassForProposalType` + `PROPOSAL_TYPE_SCHEMAS` in Task 2; referenced in Tasks 4, 5, 7. Consistent.
- `CreateBookingExecutionHandler(appointmentRepo?, auditRepo?)` — defined Task 4, matches its registry construction `new CreateBookingExecutionHandler(deps?.appointmentRepo, deps?.auditRepo)`.
- `auditRepo` — added to the registry `deps` type in Task 4, wired in `app.ts` in Task 4, consumed by reschedule/cancel handlers in Task 6. The Task 6 note correctly states no further `app.ts` change is needed.
- `rejectProposal(..., appointmentRepo?)` — 8th optional param defined Task 5, passed by the route in Task 5; `createProposalsRouter(proposalRepo, appointmentRepo?)` matches its `app.ts` mount.
- `bufferMs` — added to `FindOpenSlotsInput` and `LookupAvailabilityInput` in Task 3; `DEFAULT_BUFFER_MS` exported from `availability-finder.ts`.
- `CreateAppointmentAITaskHandler(gateway, slotConflictChecker?, availabilityFinder?, appointmentRepo?)` — 4th optional param defined Task 7, matches its `voice-action-router.ts` construction.

**4. Dependency order** — Task 1 (model) → Task 2 (type) are independent foundations; Task 3 needs Task 1; Task 4 needs Tasks 1+2; Task 5 needs Tasks 1+2; Task 6 needs Task 4's `auditRepo` registry wiring; Task 7 needs Tasks 1+2. The 1→7 order satisfies all dependencies, and each task ends green (tests + typecheck), so the branch is shippable at any task boundary.
