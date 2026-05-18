# Time Tracking per Technician Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Technicians clock in when they arrive at a job and clock out when they leave. Office staff (owners and dispatchers) can view time entries per technician, filter by date range, and export a CSV suitable for payroll processing. The feature integrates with the existing proposal system so that voice-driven clock events flow through the review-and-approve cycle, while dispatchers retain the ability to clock technicians in and out directly via REST endpoints.

**Architecture:** A new `time_entries` table backed by a `TimeEntryRepository` (InMemory first, then Pg) holds the source of truth. Two new `ProposalType` values (`clock_in` / `clock_out`) plug into the existing `ExecutionHandler` registry in `packages/api/src/proposals/execution/`. An `auto_clock_on_arrived` boolean on tenant settings triggers automatic clock-in when appointment status transitions to `arrived`. Four new REST endpoints cover direct clock-in/out, listing, summary, and CSV export.

**Tech Stack:** TypeScript, Express, `pg` driver (same as all other API features). React + Tailwind for the dispatcher time tracking view. No new runtime dependencies — CSV serialization is done inline with a small helper, and timezone formatting uses `Intl.DateTimeFormat` already present in Node.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/time-entries/time-entry.ts` | `TimeEntry` domain interface, `TimeEntryRepository` interface, factory `createTimeEntry()`, `InMemoryTimeEntryRepository` |
| `packages/api/src/time-entries/pg-time-entry.ts` | `PgTimeEntryRepository` — Postgres implementation using `PgBaseRepository.withTenant` |
| `packages/api/src/proposals/contracts/clock.ts` | `clockInPayloadSchema` and `clockOutPayloadSchema` (zod) |
| `packages/api/src/proposals/execution/clock-handler.ts` | `ClockInExecutionHandler` and `ClockOutExecutionHandler` |
| `packages/api/src/time-entries/csv.ts` | `buildTimeEntryCsv(entries, tenantTimezone)` — returns CSV string with UTC + local columns |
| `packages/api/src/routes/time-entries.ts` | Express router for `POST /clock-in`, `POST /clock-out`, `GET /`, `GET /summary`, `GET /export` |
| `packages/web/src/pages/dispatcher/TimeTrackingPage.tsx` | Main time tracking view — weekly/daily toggle, per-technician table, manual clock controls, CSV export button |
| `packages/web/src/components/time-tracking/TimeEntryRow.tsx` | Single row rendering one time entry with clock-out button |
| `packages/web/src/components/time-tracking/TimeTrackingSummary.tsx` | Aggregate totals strip (hours per technician for the range) |
| `packages/api/test/time-entries/time-entry.test.ts` | Domain + InMemory repo tests |
| `packages/api/test/time-entries/pg-time-entry.test.ts` | Pg repo integration tests (skipped unless `TEST_DB_URL` present) |
| `packages/api/test/proposals/execution/clock-handler.test.ts` | `ClockInExecutionHandler` and `ClockOutExecutionHandler` unit tests |
| `packages/api/test/routes/time-entries.route.test.ts` | Route-level integration tests |
| `packages/api/test/time-entries/csv.test.ts` | CSV builder unit tests |

> **Migration mechanism:** This codebase does **not** use a `packages/api/migrations/*.sql` directory. The migration runner in `packages/api/src/db/migrate.ts` calls `getMigrationSQL()` which concatenates the `MIGRATIONS` object exported from `packages/api/src/db/schema.ts:25` (each value is a SQL string keyed by `'NNN_name'`). New migrations are added by appending entries to that object. All migration tasks below modify `schema.ts` rather than creating new SQL files.

### Modified files

**Phase 1** — `packages/api/src/db/schema.ts` (two new migration keys: `041_create_time_entries` and `042_tenant_settings_auto_clock`).

**Phase 2** — No schema changes; new files only.

**Phase 3** — `packages/api/src/proposals/proposal.ts` (extend `ProposalType` union and `VALID_PROPOSAL_TYPES` array). `packages/api/src/proposals/contracts.ts` (import and re-export clock schemas). `packages/api/src/proposals/execution/handlers.ts` (import and instantiate `ClockInExecutionHandler` / `ClockOutExecutionHandler` in the factory/wiring). `packages/api/src/appointments/appointment.ts` (add `auto_clock` side-effect call inside `updateAppointment` when status transitions to `arrived`).

**Phase 4** — `packages/api/src/app.ts` (mount `/api/time-entries` router). `packages/api/src/settings/settings.ts` (add `autoClockOnArrived` field to `TenantSettings` interface and `InMemorySettingsRepository`).

**Phase 5** — `packages/web/src/routes.ts` (add `/time-tracking` route). `packages/web/src/components/layout/Shell.tsx` or nav equivalent (add "Time Tracking" link visible to owners and dispatchers).

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Database

Add the `time_entries` table and the `auto_clock_on_arrived` tenant setting. Both are purely additive schema changes — no existing queries break.

### Task 1: `041_create_time_entries` migration

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Append a new key to the `MIGRATIONS` object. The partial unique index `WHERE ended_at IS NULL` enforces at the database level that a technician cannot have two simultaneously open entries — an application-level guard in the handler is a second layer, not a substitute. The `technician_id` column is `TEXT` (matching the existing `technician_location_pings` pattern) rather than a UUID FK because technician identity comes from Clerk user IDs which are opaque strings. The `appointment_id` and `job_id` FK columns are nullable since a technician might clock in without an active appointment (manual break, training day).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/time-entries/time-entry.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryTimeEntryRepository, createTimeEntry } from '../../src/time-entries/time-entry';

describe('time_entries — domain (Phase 1 sentinel)', () => {
  it('InMemoryTimeEntryRepository exists and is importable', () => {
    const repo = new InMemoryTimeEntryRepository();
    expect(repo).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/time-entries/time-entry.test.ts -t "InMemoryTimeEntryRepository exists"`
Expected: FAIL — module `../../src/time-entries/time-entry` does not exist

- [ ] **Step 3: Implement**

Append to the `MIGRATIONS` object in `packages/api/src/db/schema.ts` (after the `'040_create_technician_location_pings'` entry):

```sql
'041_create_time_entries': `
  CREATE TABLE IF NOT EXISTS time_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    technician_id TEXT NOT NULL,
    appointment_id UUID REFERENCES appointments(id),
    job_id UUID REFERENCES jobs(id),
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    break_minutes INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_time_entries_tenant_tech
    ON time_entries(tenant_id, technician_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_time_entries_tenant_appointment
    ON time_entries(tenant_id, appointment_id)
    WHERE appointment_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_open_entry
    ON time_entries(tenant_id, technician_id)
    WHERE ended_at IS NULL;
  ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
  ALTER TABLE time_entries FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_time_entries ON time_entries;
  CREATE POLICY tenant_isolation_time_entries ON time_entries
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,
```

Create the stub `packages/api/src/time-entries/time-entry.ts` with just the exported class so the test file can import it (full implementation is Task 4).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/src/time-entries/time-entry.ts packages/api/test/time-entries/time-entry.test.ts
git commit -m "feat(time-tracking): add 041_create_time_entries migration + domain stub"
```

---

### Task 2: `042_tenant_settings_auto_clock` migration

**Files:**
- Modify: `packages/api/src/db/schema.ts`
- Modify: `packages/api/src/settings/settings.ts`

**Context:** `auto_clock_on_arrived` defaults to `FALSE` so existing tenants are unaffected. The column is added to the `tenant_settings` table (migration `'018_create_tenant_settings'` or wherever that table lives — check with `grep -n tenant_settings`). The `TenantSettings` TypeScript interface and `InMemorySettingsRepository` must grow the matching optional field.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/time-entries/time-entry.test.ts  (append)
import { InMemorySettingsRepository } from '../../src/settings/settings';

it('TenantSettings has autoClockOnArrived field', async () => {
  const repo = new InMemorySettingsRepository();
  const s = await repo.create({
    id: 'sid', tenantId: 'tid', businessName: 'Acme',
    timezone: 'America/New_York', estimatePrefix: 'EST-', invoicePrefix: 'INV-',
    nextEstimateNumber: 1, nextInvoiceNumber: 1, defaultPaymentTermDays: 30,
    autoClockOnArrived: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  expect(s.autoClockOnArrived).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/time-entries/time-entry.test.ts -t "TenantSettings has autoClockOnArrived"`
Expected: FAIL — TypeScript type error / property does not exist on `TenantSettings`

- [ ] **Step 3: Implement**

Append to `MIGRATIONS` in `schema.ts`:

```sql
'042_tenant_settings_auto_clock': `
  ALTER TABLE tenant_settings
    ADD COLUMN IF NOT EXISTS auto_clock_on_arrived BOOLEAN NOT NULL DEFAULT FALSE;
`,
```

In `packages/api/src/settings/settings.ts`, add `autoClockOnArrived?: boolean` to both `TenantSettings` and `CreateSettingsInput`/`UpdateSettingsInput` interfaces. In `InMemorySettingsRepository.create`, spread the field through unchanged.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/src/settings/settings.ts packages/api/test/time-entries/time-entry.test.ts
git commit -m "feat(time-tracking): add 042_tenant_settings_auto_clock migration + settings field"
```

---

## Phase 2: TimeEntryRepository

Build the full domain layer: interfaces, factory function, `InMemoryTimeEntryRepository`, and `PgTimeEntryRepository`. Tests use InMemory exclusively; the Pg implementation is tested only when `TEST_DB_URL` is set.

### Task 3: Domain model & InMemory repository

**Files:**
- Create: `packages/api/src/time-entries/time-entry.ts`
- Create: `packages/api/test/time-entries/time-entry.test.ts`

**Context:** `TimeEntry.endedAt` is `null` when the technician is currently clocked in. `durationMinutes()` is a pure helper (not stored) — it returns `null` for open entries. `findOpenEntry` is the critical query: the handler calls it before clock-in to enforce the partial unique index invariant at the application layer, giving a clear error message before a DB constraint fires.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/time-entries/time-entry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTimeEntry, durationMinutes,
  InMemoryTimeEntryRepository,
} from '../../src/time-entries/time-entry';

const T = '550e8400-e29b-41d4-a716-446655440000';

describe('TimeEntry domain', () => {
  it('createTimeEntry sets sensible defaults', () => {
    const e = createTimeEntry({
      tenantId: T, technicianId: 'tech-1',
      startedAt: new Date('2026-04-23T08:00:00Z'),
      createdBy: 'user-1',
    });
    expect(e.id).toBeDefined();
    expect(e.endedAt).toBeNull();
    expect(e.breakMinutes).toBe(0);
  });

  it('durationMinutes returns null for open entry', () => {
    const e = createTimeEntry({ tenantId: T, technicianId: 'tech-1',
      startedAt: new Date('2026-04-23T08:00:00Z'), createdBy: 'u1' });
    expect(durationMinutes(e)).toBeNull();
  });

  it('durationMinutes subtracts break from elapsed', () => {
    const e = createTimeEntry({ tenantId: T, technicianId: 'tech-1',
      startedAt: new Date('2026-04-23T08:00:00Z'), createdBy: 'u1' });
    const closed = { ...e, endedAt: new Date('2026-04-23T10:30:00Z'), breakMinutes: 15 };
    expect(durationMinutes(closed)).toBe(135); // 150 - 15
  });
});

describe('InMemoryTimeEntryRepository', () => {
  let repo: InMemoryTimeEntryRepository;
  beforeEach(() => { repo = new InMemoryTimeEntryRepository(); });

  it('findOpenEntry returns null when none exists', async () => {
    expect(await repo.findOpenEntry(T, 'tech-1')).toBeNull();
  });

  it('findOpenEntry returns the open entry', async () => {
    const e = createTimeEntry({ tenantId: T, technicianId: 'tech-1',
      startedAt: new Date(), createdBy: 'u1' });
    await repo.create(e);
    const found = await repo.findOpenEntry(T, 'tech-1');
    expect(found?.id).toBe(e.id);
  });

  it('sumByTechnician aggregates net minutes', async () => {
    const e1 = createTimeEntry({ tenantId: T, technicianId: 'tech-1',
      startedAt: new Date('2026-04-23T08:00:00Z'), createdBy: 'u1' });
    await repo.create({ ...e1, endedAt: new Date('2026-04-23T10:00:00Z'), breakMinutes: 30 });
    const result = await repo.sumByTechnician(T, 'tech-1',
      { from: new Date('2026-04-23T00:00:00Z'), to: new Date('2026-04-23T23:59:59Z') });
    expect(result).toBe(90); // 120 - 30
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/time-entries/time-entry.test.ts`
Expected: FAIL — module not found or exported symbols missing

- [ ] **Step 3: Implement**

Implement `packages/api/src/time-entries/time-entry.ts` with:
- `TimeEntry` interface (`id`, `tenantId`, `technicianId`, `appointmentId?`, `jobId?`, `startedAt: Date`, `endedAt: Date | null`, `breakMinutes: number`, `notes?: string`, `createdBy: string`, `createdAt: Date`, `updatedAt: Date`)
- `DateRange` interface (`from: Date`, `to: Date`)
- `TimeEntryRepository` interface with methods: `create`, `findById`, `findOpenEntry(tenantId, technicianId)`, `findByTechnician(tenantId, technicianId, range)`, `sumByTechnician(tenantId, technicianId, range)`, `update`, `listAll(tenantId, range)`
- `createTimeEntry(input)` factory using `uuidv4()`
- `durationMinutes(entry)` pure helper
- `InMemoryTimeEntryRepository` with all interface methods implemented in-memory

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/time-entries/time-entry.ts packages/api/test/time-entries/time-entry.test.ts
git commit -m "feat(time-tracking): TimeEntry domain model + InMemoryTimeEntryRepository"
```

---

### Task 4: PgTimeEntryRepository

**Files:**
- Create: `packages/api/src/time-entries/pg-time-entry.ts`

**Context:** Extends `PgBaseRepository`, uses `withTenant` for all queries. The `clock_out` update uses `WHERE ended_at IS NULL` to be idempotent. `sumByTechnician` uses `COALESCE(SUM(...), 0)` so it never returns `NULL`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/time-entries/pg-time-entry.test.ts
import { describe, it, expect } from 'vitest';
import { PgTimeEntryRepository } from '../../src/time-entries/pg-time-entry';

describe('PgTimeEntryRepository', () => {
  it('is importable and constructable with a mock pool', () => {
    const fakePool = {} as never;
    const repo = new PgTimeEntryRepository(fakePool);
    expect(repo).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/time-entries/pg-time-entry.test.ts`
Expected: FAIL — module `../../src/time-entries/pg-time-entry` does not exist

- [ ] **Step 3: Implement**

Create `packages/api/src/time-entries/pg-time-entry.ts` as a class extending `PgBaseRepository` implementing `TimeEntryRepository`. Key queries:

```typescript
// findOpenEntry
await client.query(
  `SELECT * FROM time_entries WHERE tenant_id = $1 AND technician_id = $2 AND ended_at IS NULL LIMIT 1`,
  [tenantId, technicianId]
);

// sumByTechnician — net minutes excluding break
await client.query(
  `SELECT COALESCE(
     SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60 - break_minutes), 0
   )::INTEGER AS total_minutes
   FROM time_entries
   WHERE tenant_id = $1 AND technician_id = $2
     AND started_at >= $3 AND started_at < $4
     AND ended_at IS NOT NULL`,
  [tenantId, technicianId, range.from, range.to]
);
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/time-entries/pg-time-entry.ts packages/api/test/time-entries/pg-time-entry.test.ts
git commit -m "feat(time-tracking): PgTimeEntryRepository"
```

---

## Phase 3: Proposals & Auto-Clock Hook

Register `clock_in` and `clock_out` as new proposal types, implement their execution handlers, and hook into `updateAppointment` to auto-clock when status becomes `arrived`.

### Task 5: clock_in / clock_out ProposalTypes

**Files:**
- Create: `packages/api/src/proposals/contracts/clock.ts`
- Modify: `packages/api/src/proposals/proposal.ts`
- Modify: `packages/api/src/proposals/contracts.ts`

**Context:** `clock_in` payload carries `technicianId`, optional `appointmentId`, optional `jobId`, and optional `notes`. `clock_out` payload carries `technicianId` and optional `breakMinutes` / `notes`. Both extend the existing `ProposalType` union. The `VALID_PROPOSAL_TYPES` array in `proposal.ts` must also be extended so `isValidProposalType()` accepts the new values.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/proposals/execution/clock-handler.test.ts
import { describe, it, expect } from 'vitest';
import { clockInPayloadSchema, clockOutPayloadSchema } from '../../../src/proposals/contracts/clock';

describe('clock payload schemas', () => {
  it('clockInPayloadSchema accepts valid input', () => {
    const result = clockInPayloadSchema.safeParse({ technicianId: 'tech-1' });
    expect(result.success).toBe(true);
  });

  it('clockOutPayloadSchema requires technicianId', () => {
    const result = clockOutPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/proposals/execution/clock-handler.test.ts -t "clock payload schemas"`
Expected: FAIL — module `../../src/proposals/contracts/clock` does not exist

- [ ] **Step 3: Implement**

Create `packages/api/src/proposals/contracts/clock.ts`:

```typescript
import { z } from 'zod';

export const clockInPayloadSchema = z.object({
  technicianId: z.string().min(1),
  appointmentId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  notes: z.string().optional(),
});

export const clockOutPayloadSchema = z.object({
  technicianId: z.string().min(1),
  breakMinutes: z.number().int().min(0).optional(),
  notes: z.string().optional(),
});

export type ClockInPayload = z.infer<typeof clockInPayloadSchema>;
export type ClockOutPayload = z.infer<typeof clockOutPayloadSchema>;
```

In `proposal.ts`, add `'clock_in'` and `'clock_out'` to the `ProposalType` union and to `VALID_PROPOSAL_TYPES`.

In `contracts.ts`, add imports for the two new schemas and re-export them.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/proposals/contracts/clock.ts packages/api/src/proposals/proposal.ts packages/api/src/proposals/contracts.ts packages/api/test/proposals/execution/clock-handler.test.ts
git commit -m "feat(time-tracking): register clock_in / clock_out ProposalTypes + payload schemas"
```

---

### Task 6: ClockIn & ClockOut execution handlers

**Files:**
- Create: `packages/api/src/proposals/execution/clock-handler.ts`
- Modify: `packages/api/src/proposals/execution/handlers.ts`

**Context:** `ClockInExecutionHandler` calls `repo.findOpenEntry` first. If an open entry exists, returns `{ success: false, error: 'Technician already clocked in' }`. Otherwise calls `repo.create`. `ClockOutExecutionHandler` finds the open entry, closes it by setting `ended_at = NOW()`, and returns `{ success: true, resultEntityId: entry.id }`. Both handlers are optional-repo-safe (return success without DB side-effects if repo is `undefined`) so unit tests do not need a real repo.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/proposals/execution/clock-handler.test.ts (append)
import {
  ClockInExecutionHandler,
  ClockOutExecutionHandler,
} from '../../../src/proposals/execution/clock-handler';
import { InMemoryTimeEntryRepository } from '../../../src/time-entries/time-entry';

const ctx = { tenantId: 'tid', executedBy: 'user-1' };
const baseProposal = { id: 'p1', tenantId: 'tid', status: 'approved' as const,
  proposalType: 'clock_in' as const, payload: { technicianId: 'tech-1' },
  summary: '', createdAt: new Date(), updatedAt: new Date() };

describe('ClockInExecutionHandler', () => {
  it('creates a time entry', async () => {
    const repo = new InMemoryTimeEntryRepository();
    const h = new ClockInExecutionHandler(repo);
    const r = await h.execute(baseProposal as never, ctx);
    expect(r.success).toBe(true);
    expect(r.resultEntityId).toBeDefined();
  });

  it('rejects double clock-in', async () => {
    const repo = new InMemoryTimeEntryRepository();
    const h = new ClockInExecutionHandler(repo);
    await h.execute(baseProposal as never, ctx);
    const r2 = await h.execute(baseProposal as never, ctx);
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/already clocked in/i);
  });
});

describe('ClockOutExecutionHandler', () => {
  it('closes the open entry', async () => {
    const repo = new InMemoryTimeEntryRepository();
    const inHandler = new ClockInExecutionHandler(repo);
    await inHandler.execute(baseProposal as never, ctx);

    const outProposal = { ...baseProposal, proposalType: 'clock_out' as const,
      payload: { technicianId: 'tech-1', breakMinutes: 10 } };
    const h = new ClockOutExecutionHandler(repo);
    const r = await h.execute(outProposal as never, ctx);
    expect(r.success).toBe(true);
    expect(await repo.findOpenEntry('tid', 'tech-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/proposals/execution/clock-handler.test.ts`
Expected: FAIL — `ClockInExecutionHandler` not found

- [ ] **Step 3: Implement**

Create `packages/api/src/proposals/execution/clock-handler.ts` with both handler classes. In `handlers.ts`, import and instantiate them alongside the existing handlers (pass `undefined` for the repo so the executor compilation does not break; real instantiation happens in `app.ts`).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/proposals/execution/clock-handler.ts packages/api/src/proposals/execution/handlers.ts packages/api/test/proposals/execution/clock-handler.test.ts
git commit -m "feat(time-tracking): ClockInExecutionHandler + ClockOutExecutionHandler"
```

---

### Task 7: Auto-clock hook on appointment `arrived` transition

**Files:**
- Modify: `packages/api/src/appointments/appointment.ts`

**Context:** The hook is injected via an optional `onArrived` callback parameter on `updateAppointment` — this keeps the domain function testable without circular imports. The caller in `app.ts` wires it to enqueue a `clock_in` proposal. The callback only fires when the **previous** status was not `arrived` and the **new** status is `arrived`, preventing re-triggering on idempotent updates.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/appointments/appointment.test.ts (append)
it('calls onArrived callback when status transitions to arrived', async () => {
  const repo = new InMemoryAppointmentRepository();
  const appt = await createAppointment({ /* valid input */ }, repo);
  let called = false;
  await updateAppointment(appt.tenantId, appt.id,
    { status: 'arrived' as never },
    repo,
    { onArrived: async (_a) => { called = true; } }
  );
  expect(called).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/appointments/appointment.test.ts -t "calls onArrived callback"`
Expected: FAIL — `updateAppointment` does not accept an `options` object with `onArrived`

- [ ] **Step 3: Implement**

Extend `AppointmentWriteOptions` with `onArrived?: (appointment: Appointment) => Promise<void>`. Inside `updateAppointment`, after the status update is persisted, check `updates.status === 'arrived' && previous.status !== 'arrived'` and `await options.onArrived?.(updated)`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/appointments/appointment.ts packages/api/test/appointments/appointment.test.ts
git commit -m "feat(time-tracking): auto-clock hook on appointment arrived transition"
```

---

## Phase 4: API Endpoints & CSV Export

Expose the time-tracking operations over REST. All endpoints require `requireAuth` + `requireTenant`. Clock-in and clock-out are available to all roles. List, summary, and export require `dispatcher` or `owner`.

### Task 8: POST /clock-in and POST /clock-out

**Files:**
- Create: `packages/api/src/routes/time-entries.ts`
- Modify: `packages/api/src/app.ts`

**Context:** The direct-API clock-in skips the proposal system — it creates a `TimeEntry` row immediately. This is the dispatcher's "manual override" path. The route also enforces the same double-clock guard as the handler (call `findOpenEntry` and return `409 CONFLICT` if an open entry exists).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/routes/time-entries.route.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp } from '../../src/app';
import { InMemoryTimeEntryRepository } from '../../src/time-entries/time-entry';

describe('POST /api/time-entries/clock-in', () => {
  let app: Express.Application;
  let repo: InMemoryTimeEntryRepository;

  beforeEach(() => {
    repo = new InMemoryTimeEntryRepository();
    app = buildApp({ timeEntryRepo: repo, /* other deps */ });
  });

  it('returns 201 with a time entry', async () => {
    const res = await request(app)
      .post('/api/time-entries/clock-in')
      .set('x-test-tenant', 'tid')
      .send({ technicianId: 'tech-1' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.endedAt).toBeNull();
  });

  it('returns 409 when technician already clocked in', async () => {
    await request(app).post('/api/time-entries/clock-in')
      .set('x-test-tenant', 'tid').send({ technicianId: 'tech-1' });
    const res = await request(app).post('/api/time-entries/clock-in')
      .set('x-test-tenant', 'tid').send({ technicianId: 'tech-1' });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/time-entries.route.test.ts`
Expected: FAIL — route `/api/time-entries/clock-in` returns 404

- [ ] **Step 3: Implement**

Create `packages/api/src/routes/time-entries.ts` exporting `createTimeEntriesRouter(repo: TimeEntryRepository, settingsRepo: SettingsRepository)`. Implement `POST /clock-in` and `POST /clock-out` using Zod validation, `findOpenEntry` guard (409 on conflict), `createTimeEntry`, and `repo.create`.

Mount in `app.ts`: `app.use('/api/time-entries', createTimeEntriesRouter(timeEntryRepo, settingsRepo))`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/time-entries.ts packages/api/src/app.ts packages/api/test/routes/time-entries.route.test.ts
git commit -m "feat(time-tracking): POST /api/time-entries/clock-in and /clock-out routes"
```

---

### Task 9: GET /api/time-entries and GET /summary

**Files:**
- Modify: `packages/api/src/routes/time-entries.ts`

**Context:** `GET /api/time-entries?technicianId=&from=&to=` requires `owner` or `dispatcher` role. Technicians may query their own entries if `technicianId` matches their user ID. `GET /api/time-entries/summary?from=&to=` returns `{ technicians: [{ technicianId, totalMinutes, entryCount }] }`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/routes/time-entries.route.test.ts (append)
describe('GET /api/time-entries', () => {
  it('returns entries for the date range', async () => {
    await request(app).post('/api/time-entries/clock-in')
      .set('x-test-tenant', 'tid').send({ technicianId: 'tech-1' });
    const res = await request(app)
      .get('/api/time-entries?technicianId=tech-1&from=2026-01-01&to=2026-12-31')
      .set('x-test-tenant', 'tid');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/time-entries.route.test.ts -t "returns entries for the date range"`
Expected: FAIL — 404 or missing `entries` key

- [ ] **Step 3: Implement**

Add `GET /` handler: parse `technicianId`, `from`, `to` query params, call `repo.findByTechnician` or `repo.listAll`, return `{ entries }`. Add `GET /summary` handler: call `repo.listAll(tenantId, range)`, group by `technicianId`, sum `durationMinutes`, return array.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/time-entries.ts packages/api/test/routes/time-entries.route.test.ts
git commit -m "feat(time-tracking): GET /api/time-entries and /summary endpoints"
```

---

### Task 10: GET /api/time-entries/export (CSV)

**Files:**
- Create: `packages/api/src/time-entries/csv.ts`
- Modify: `packages/api/src/routes/time-entries.ts`
- Create: `packages/api/test/time-entries/csv.test.ts`

**Context:** Times are stored UTC; the CSV must include both UTC ISO columns and tenant-local columns formatted with `Intl.DateTimeFormat`. `duration_hours` is `(durationMinutes / 60).toFixed(2)`. Open entries (null `ended_at`) are included but have empty `ended_at_*` and `duration_hours` cells.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/time-entries/csv.test.ts
import { describe, it, expect } from 'vitest';
import { buildTimeEntryCsv } from '../../src/time-entries/csv';
import { createTimeEntry } from '../../src/time-entries/time-entry';

describe('buildTimeEntryCsv', () => {
  it('includes both UTC and local columns', () => {
    const e = createTimeEntry({ tenantId: 'tid', technicianId: 'tech-1',
      startedAt: new Date('2026-04-23T14:00:00Z'), createdBy: 'u1' });
    const closed = { ...e, endedAt: new Date('2026-04-23T16:30:00Z'), breakMinutes: 0 };
    const csv = buildTimeEntryCsv([{ entry: closed, technicianName: 'Alice Smith' }], 'America/New_York');
    expect(csv).toContain('technician_name');
    expect(csv).toContain('started_at_utc');
    expect(csv).toContain('started_at_local');
    expect(csv).toContain('2.50'); // 2.5 hours
    expect(csv).toContain('Alice Smith');
  });

  it('leaves duration_hours empty for open entries', () => {
    const e = createTimeEntry({ tenantId: 'tid', technicianId: 'tech-1',
      startedAt: new Date('2026-04-23T14:00:00Z'), createdBy: 'u1' });
    const csv = buildTimeEntryCsv([{ entry: e, technicianName: 'Bob' }], 'America/New_York');
    const rows = csv.split('\n');
    expect(rows[1].split(',')[6]).toBe(''); // duration_hours column empty
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/time-entries/csv.test.ts`
Expected: FAIL — module `../../src/time-entries/csv` does not exist

- [ ] **Step 3: Implement**

Create `packages/api/src/time-entries/csv.ts` with `buildTimeEntryCsv(rows: Array<{ entry: TimeEntry; technicianName: string }>, timezone: string): string`. Use `Intl.DateTimeFormat` with `timeZone` option for the `_local` columns. Columns: `technician_name`, `date`, `started_at_utc`, `ended_at_utc`, `started_at_local`, `ended_at_local`, `duration_hours`, `break_minutes`, `appointment_id`, `notes`.

Add `GET /export` to the router: fetch entries, load tenant settings for timezone, call `buildTimeEntryCsv`, set `Content-Type: text/csv` + `Content-Disposition: attachment; filename="time-entries.csv"`.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/time-entries/csv.ts packages/api/src/routes/time-entries.ts packages/api/test/time-entries/csv.test.ts
git commit -m "feat(time-tracking): CSV export with UTC + tenant-local time columns"
```

---

## Phase 5: Dispatcher Time Tracking View

Add a `/time-tracking` page in the web app showing time entries per technician for the current week, with a daily/weekly toggle, manual clock controls, and a CSV export button.

### Task 11: TimeEntryRow & TimeTrackingSummary components

**Files:**
- Create: `packages/web/src/components/time-tracking/TimeEntryRow.tsx`
- Create: `packages/web/src/components/time-tracking/TimeTrackingSummary.tsx`

**Context:** `TimeEntryRow` displays one row of a table — technician name, start/end times formatted in browser locale, duration, break, and a "Clock Out" button (disabled for closed entries). `TimeTrackingSummary` renders the aggregate strip across the top: one chip per technician showing total hours for the selected range.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/time-tracking/TimeEntryRow.test.tsx
import { render, screen } from '@testing-library/react';
import { TimeEntryRow } from './TimeEntryRow';

const entry = {
  id: 'e1', technicianId: 'tech-1', technicianName: 'Alice',
  startedAt: '2026-04-23T08:00:00Z', endedAt: '2026-04-23T10:00:00Z',
  breakMinutes: 15, notes: null, appointmentId: null,
};

it('renders technician name and duration', () => {
  render(<TimeEntryRow entry={entry} onClockOut={() => {}} />);
  expect(screen.getByText('Alice')).toBeTruthy();
  expect(screen.getByText(/1\.75 hrs/i)).toBeTruthy(); // 105 min / 60
});

it('shows disabled clock-out button for closed entries', () => {
  render(<TimeEntryRow entry={entry} onClockOut={() => {}} />);
  expect(screen.getByRole('button', { name: /clocked out/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/time-tracking/TimeEntryRow.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `TimeEntryRow.tsx` as a functional component using Tailwind classes, matching the visual style of `AppointmentCard.tsx`. Create `TimeTrackingSummary.tsx` accepting `summaryItems: Array<{ technicianId, technicianName, totalMinutes }>` and rendering a flex row of summary chips.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/time-tracking/
git commit -m "feat(time-tracking): TimeEntryRow + TimeTrackingSummary components"
```

---

### Task 12: useTimeEntries hook

**Files:**
- Create: `packages/web/src/hooks/useTimeEntries.ts`

**Context:** Wraps `fetch` calls to `/api/time-entries` and `/api/time-entries/summary`. Accepts `{ technicianId?, from, to }` and returns `{ entries, summary, loading, error, clockIn, clockOut }`. Follows the same pattern as other data hooks in the codebase (`useCreateScheduleProposal`, etc.).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/hooks/useTimeEntries.test.ts
import { renderHook, waitFor } from '@testing-library/react';
import { useTimeEntries } from './useTimeEntries';

it('is importable', () => {
  expect(useTimeEntries).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/hooks/useTimeEntries.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `packages/web/src/hooks/useTimeEntries.ts` using `useState` + `useEffect` for fetching. `clockIn(technicianId, appointmentId?)` POSTs to `/api/time-entries/clock-in`. `clockOut(technicianId, breakMinutes?)` POSTs to `/api/time-entries/clock-out`. Refetch after both mutations.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/hooks/useTimeEntries.ts
git commit -m "feat(time-tracking): useTimeEntries data hook"
```

---

### Task 13: TimeTrackingPage + route registration

**Files:**
- Create: `packages/web/src/pages/dispatcher/TimeTrackingPage.tsx`
- Modify: `packages/web/src/routes.ts`

**Context:** The page renders a date-range picker (defaulting to the current Mon–Sun week), a daily/weekly toggle that changes the grouping level, the `TimeTrackingSummary` strip, and a scrollable table of `TimeEntryRow` components. The "Export CSV" button opens `GET /api/time-entries/export?from=&to=` as a direct `<a download>` link. The manual clock-in control is a dispatcher-only button that calls `clockIn(selectedTechnicianId)`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/pages/dispatcher/TimeTrackingPage.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { TimeTrackingPage } from './TimeTrackingPage';

it('renders the page heading', () => {
  render(<MemoryRouter><TimeTrackingPage /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: /time tracking/i })).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/pages/dispatcher/TimeTrackingPage.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `TimeTrackingPage.tsx` composing `useTimeEntries`, `TimeTrackingSummary`, and `TimeEntryRow` with a date-range state (`weekStart` / `weekEnd` derived from `date-fns` or inline ISO arithmetic — no new dep needed). Add `{ path: 'time-tracking', Component: TimeTrackingPage }` to the Shell children in `routes.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/pages/dispatcher/TimeTrackingPage.tsx packages/web/src/routes.ts
git commit -m "feat(time-tracking): TimeTrackingPage dispatcher view + /time-tracking route"
```

---

### Task 14: Nav link & settings toggle UI

**Files:**
- Modify: `packages/web/src/components/layout/Shell.tsx` (or equivalent nav component)
- Modify: `packages/web/src/components/settings/SettingsPage.tsx`

**Context:** Add a "Time Tracking" nav link visible only to users with `owner` or `dispatcher` roles. Add an `Auto clock-in on arrival` toggle to the settings page that PUTs `{ autoClockOnArrived: boolean }` to `/api/settings`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/layout/Shell.test.tsx (new or append)
it('shows Time Tracking link for dispatcher role', () => {
  render(<MockAuthProvider role="dispatcher"><Shell /></MockAuthProvider>);
  expect(screen.getByRole('link', { name: /time tracking/i })).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/layout/Shell.test.tsx -t "shows Time Tracking link"`
Expected: FAIL — link element not found

- [ ] **Step 3: Implement**

Locate the nav link list in `Shell.tsx` and insert the "Time Tracking" entry guarded by a role check. In `SettingsPage.tsx`, add a toggle switch that reads `settings.autoClockOnArrived` and PUTs the updated value.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/layout/Shell.tsx packages/web/src/components/settings/SettingsPage.tsx
git commit -m "feat(time-tracking): nav link + auto-clock-on-arrival settings toggle"
```

---

## Out of scope

- Payroll integration with third-party providers (Gusto, ADP, QuickBooks Payroll)
- Overtime calculation (1.5x / 2x rules, jurisdiction-specific thresholds)
- Geofenced auto-clock (clock in automatically when device enters a job site radius)
- Break tracking UI (starting / ending breaks as first-class events separate from `break_minutes`)
- Timesheet approval workflow (manager sign-off, dispute resolution, locked periods)
- Per-technician pay rates or cost calculations
- Mobile-native push notifications for missed clock-out reminders
- Historical correction / amendment of already-exported entries

### Critical Files for Implementation
- `/home/user/Serviceos/packages/api/src/db/schema.ts`
- `/home/user/Serviceos/packages/api/src/time-entries/time-entry.ts`
- `/home/user/Serviceos/packages/api/src/proposals/execution/clock-handler.ts`
- `/home/user/Serviceos/packages/api/src/routes/time-entries.ts`
- `/home/user/Serviceos/packages/web/src/pages/dispatcher/TimeTrackingPage.tsx`
