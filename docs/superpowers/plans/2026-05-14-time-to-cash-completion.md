# Time-to-Cash Completion (§6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every job a denormalized, always-current money-state (`no_estimate → estimate_sent → estimate_accepted → invoiced → paid`, with `overdue` as an escalation of `invoiced`), maintained automatically on every estimate/invoice/payment mutation, and add an overdue-invoice sweep that emits an `invoice.overdue` event for §7's dunning layer.

**Architecture:** A `JobMoneyState` string union on `Job` (backed by a new `money_state` column). A **pure** `computeJobMoneyState(estimates, invoices, now)` precedence function. A `refreshJobMoneyState` orchestrator that reloads a job's estimates+invoices, recomputes, persists on change, and emits a `job.money_state_changed` audit event — plus a non-throwing `refreshJobMoneyStateSafe` wrapper for call sites that must never bounce on a rollup failure. The refresh is threaded through the **domain functions** that are the money-mutation choke points (`recordPayment`, `issueInvoice`, `transitionInvoiceStatus`, `transitionEstimateStatus`) — so the invoice/estimate routes *and* the Stripe webhook (which calls `recordPayment`) all get the rollup for free. The estimate `/send` route gets one explicit refresh call (its status change happens inside `SendService`, not a threadable function). Finally, a cross-tenant `runOverdueInvoiceSweep` worker (P0-009 `setInterval` pattern) flips overdue jobs and emits `invoice.overdue`.

**Tech Stack:** TypeScript, Node, Express. Tests: vitest + supertest. Persistence: PostgreSQL via the `schema.ts` keyed-migration object; in-memory repositories for tests.

---

## Context the executing engineer needs

**This is a delta on an ~85%-built money pipeline.** A focused codebase explore (committed in `4b6a7111`, which corrects the launch-readiness spec) established that two things the broad audit called gaps are **already done** and are NOT in this plan's scope:

- The Stripe `checkout.session.completed` webhook is wired end-to-end on the **invoice** side — `webhooks/routes.ts` verifies the signature, dedups on the P0-014 base, and calls `recordPayment`, which marks the invoice `paid`/`partially_paid`. This plan only adds the **job-side** rollup on top of that existing call.
- The `reschedule_appointment` / `cancel_appointment` execution handlers are fully implemented — **not** touched by this plan.

**Money-state precedence (the heart of the feature).** Given all of a job's estimates and invoices, exactly one state describes it. Highest-priority match wins:

| Priority | State | Condition |
|---|---|---|
| 1 | `overdue` | an `open`/`partially_paid` invoice exists whose `dueDate` is before `now` |
| 2 | `invoiced` | an `open`/`partially_paid` invoice exists (none overdue) |
| 3 | `paid` | every invoice that exists is fully `paid` |
| 4 | `estimate_accepted` | an `accepted` estimate exists |
| 5 | `estimate_sent` | a `sent` estimate exists |
| 6 | `no_estimate` | nothing above matched |

"Still owes money" (`invoiced`/`overdue`) outranks `paid` on purpose: a second invoice or a partial payment means money is outstanding, and that is what the owner needs to see. Invoice states outrank estimate states. **Ignored entirely:** `draft`/`void`/`canceled` invoices and `draft`/`ready_for_review`/`rejected`/`expired` estimates — they carry no money-state signal.

**Key existing code (exact shapes the tasks depend on):**

- `Job` (`packages/api/src/jobs/job.ts`): `status: JobStatus` plus deposit-specific money fields (`depositRequiredCents` / `depositPaidCents` / `depositStatus`). `createJob(input, repo, auditRepo?)` builds the row. `InMemoryJobRepository.update` does `{ ...j, ...updates }` (so a new optional field needs no in-memory change). `JobRepository.findById(tenantId, id)` and `.update(tenantId, id, Partial<Job>)`.
- `Estimate` (`packages/api/src/estimates/estimate.ts`): `status: EstimateStatus = 'draft' | 'ready_for_review' | 'sent' | 'accepted' | 'rejected' | 'expired'`. `transitionEstimateStatus(tenantId, id, newStatus, repository)` returns the updated `Estimate | null`. `EstimateRepository.findByJob(tenantId, jobId)`.
- `Invoice` (`packages/api/src/invoices/invoice.ts`): `status: InvoiceStatus = 'draft' | 'open' | 'partially_paid' | 'paid' | 'void' | 'canceled'`, `dueDate?: Date`, `jobId`, `amountDueCents`, `totals: DocumentTotals`. `issueInvoice(tenantId, id, paymentTermDays, repository)` and `transitionInvoiceStatus(tenantId, id, newStatus, repository)` return updated `Invoice | null`. `InvoiceRepository.findByJob` and `.findByTenant(tenantId, { status?, toDueDate? })`.
- `recordPayment(input, invoiceRepo, paymentRepo)` (`packages/api/src/invoices/payment.ts`): records the payment, updates invoice balances/status, returns `{ payment, invoice }`.
- `createAuditEvent({ tenantId, actorId, actorRole, eventType, entityType, entityId, metadata? })` and `AuditRepository.create` (`packages/api/src/audit/audit.ts`). `InMemoryAuditRepository` exists.
- `createLogger({ service, environment, level? })` → `Logger` (`packages/api/src/logging/logger.ts`).
- Worker pattern: `packages/api/src/workers/recurring-agreements-worker.ts` — cross-tenant sweep, per-tenant `try/catch` so one failure never crashes the loop, driven by a `setInterval` in `app.ts`.
- Migrations: `packages/api/src/db/schema.ts` exports `const MIGRATIONS = { '016_create_jobs': '...', ..., '094_add_held_appointment_fields': '...' }`; `getMigrationSQL()` joins `Object.values(MIGRATIONS)`. The whole SQL is re-run on every boot, so every statement must be idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). The latest key is `094_add_held_appointment_fields`.
- Router wiring lives in `packages/api/src/app.ts` (`createEstimateRouter` at line ~1869, `createInvoiceRouter` at line ~1874, `createWebhookRouter` deps at line ~642) and `packages/api/test/routes/test-app.ts` (`buildTestApp()`, lines ~99–100). The Stripe webhook uses separate repo instances `webhookInvoiceRepo` / `webhookPaymentRepo` / `webhookAuditRepo` (app.ts lines ~531–573); `jobRepo` is hoisted (line ~537) and shared.

**Avoiding a circular import.** `job-money-state.ts` must import `Estimate` / `Invoice` / `EstimateRepository` / `InvoiceRepository` / `Job` / `JobRepository` / `JobMoneyState` as **`import type`** only (they are erased at compile time). Its only *value* import is `createAuditEvent` from `audit/audit`. The estimate/invoice/payment modules then `import` the *value* `refreshJobMoneyStateSafe` from `job-money-state.ts` — the runtime graph is `estimate.ts → job-money-state.ts → audit/audit`, with no cycle.

**Commands:**
- Run one API test file: from `packages/api`, `npm test -- <relative/path/to/test>`
- API production typecheck (the Railway build — mandatory before any commit): from repo root, `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- Full API test suite: from `packages/api`, `npm test`

---

## File Structure

**Created:**
- `packages/api/src/jobs/job-money-state.ts` — `computeJobMoneyState` (pure precedence fn), `refreshJobMoneyState` + `refreshJobMoneyStateSafe` (orchestrators), and the `RefreshJobMoneyStateDeps` / `RefreshJobMoneyStateResult` types. One responsibility: own the money-state computation and the persist-and-emit rollup.
- `packages/api/test/jobs/job-money-state.test.ts` — unit tests for the field default, `computeJobMoneyState`, and `refreshJobMoneyState`/`Safe`.
- `packages/api/test/jobs/job-money-state-wiring.test.ts` — unit tests proving the four domain functions trigger a refresh when given deps.
- `packages/api/src/workers/overdue-invoice-worker.ts` — `runOverdueInvoiceSweep` cross-tenant sweep.
- `packages/api/test/workers/overdue-invoice-worker.test.ts` — worker tests.

**Modified:**
- `packages/api/src/jobs/job.ts` — add `JobMoneyState` type, `Job.moneyState` field, `createJob` default.
- `packages/api/src/jobs/pg-job.ts` — `mapRow` + `update` field-map entries for `money_state`.
- `packages/api/src/db/schema.ts` — add the `095_jobs_money_state` migration.
- `packages/api/src/invoices/payment.ts` — `recordPayment` gains an optional money-state deps param.
- `packages/api/src/invoices/invoice.ts` — `issueInvoice` + `transitionInvoiceStatus` gain the param.
- `packages/api/src/estimates/estimate.ts` — `transitionEstimateStatus` gains the param.
- `packages/api/src/routes/invoices.ts` — `createInvoiceRouter` gains an `estimateRepo?` param; threads refresh deps into `issueInvoice` / `recordPayment` / `transitionInvoiceStatus`.
- `packages/api/src/routes/estimates.ts` — `createEstimateRouter` gains a `moneyStateDeps?` param; threads deps into `transitionEstimateStatus` and adds an explicit refresh to `/send`.
- `packages/api/src/webhooks/routes.ts` — `WebhookRouterDeps` gains `estimateRepo?`; the Stripe handler passes refresh deps into `recordPayment`.
- `packages/api/src/app.ts` — pass the new repos into the two routers + the webhook; construct `webhookEstimateRepo`; schedule the overdue worker.
- `packages/api/test/routes/test-app.ts` — pass the new repos into the two routers.

---

## Task 1: `JobMoneyState` type, `Job.moneyState` field, migration, Pg mapping

**Files:**
- Modify: `packages/api/src/jobs/job.ts`
- Modify: `packages/api/src/jobs/pg-job.ts`
- Modify: `packages/api/src/db/schema.ts`
- Test: `packages/api/test/jobs/job-money-state.test.ts`

- [ ] **Step 1: Create the working branch**

```bash
git checkout main && git checkout -b feat/time-to-cash-completion
```

- [ ] **Step 2: Write the failing test**

Create `packages/api/test/jobs/job-money-state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';

describe('Job.moneyState field', () => {
  it('createJob defaults moneyState to no_estimate', async () => {
    const repo = new InMemoryJobRepository();
    const job = await createJob(
      {
        tenantId: 't1',
        customerId: 'c1',
        locationId: 'l1',
        summary: 'Fix AC',
        createdBy: 'u1',
      },
      repo,
    );
    expect(job.moneyState).toBe('no_estimate');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/jobs/job-money-state.test.ts`
Expected: FAIL — `expected undefined to be 'no_estimate'` (the field doesn't exist yet).

- [ ] **Step 4: Add the `JobMoneyState` type and `Job.moneyState` field**

In `packages/api/src/jobs/job.ts`, add the type immediately after the `JobPriority` type (line 7):

```typescript
export type JobPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * §6 Time-to-Cash. Denormalized rollup of where a job sits in the
 * estimate → invoice → payment chain. Maintained by
 * `refreshJobMoneyState` (jobs/job-money-state.ts).
 */
export type JobMoneyState =
  | 'no_estimate'
  | 'estimate_sent'
  | 'estimate_accepted'
  | 'invoiced'
  | 'paid'
  | 'overdue';
```

Then, inside the `Job` interface, add the field immediately before `createdBy: string;` (after the `depositCreditedToInvoiceId?` block):

```typescript
  depositCreditedToInvoiceId?: string;
  /**
   * §6 Time-to-Cash. Denormalized money-state rollup, maintained by
   * `refreshJobMoneyState` on every estimate/invoice/payment mutation
   * and by the overdue-invoice sweep. Optional in TS so legacy
   * fixtures/tests can omit it; the Pg column DEFAULTs to 'no_estimate'.
   */
  moneyState?: JobMoneyState;
  createdBy: string;
```

Then, inside `createJob`, add the default to the `job` object immediately after `depositStatus: 'not_required',`:

```typescript
    depositStatus: 'not_required',
    moneyState: 'no_estimate',
    createdBy: input.createdBy,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/jobs/job-money-state.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the Pg column mapping**

In `packages/api/src/jobs/pg-job.ts`, add `JobMoneyState` to the import from `./job`:

```typescript
import {
  Job,
  JobFindByCustomerOptions,
  JobListOptions,
  JobListResult,
  JobRepository,
  JobMoneyState,
  DEFAULT_JOB_LIMIT,
  MAX_JOB_LIMIT,
} from './job';
```

In `mapRow`, add the field immediately after the `depositCreditedToInvoiceId` mapping and before `createdBy`:

```typescript
    depositCreditedToInvoiceId:
      (row.deposit_credited_to_invoice_id as string | null) ?? undefined,
    // §6 Time-to-Cash. Migration 095; DEFAULT 'no_estimate' for legacy rows.
    moneyState: (row.money_state as JobMoneyState | null) ?? 'no_estimate',
    createdBy: row.created_by as string,
```

In the `update` method's `fieldMap`, add the entry immediately after `depositCreditedToInvoiceId: 'deposit_credited_to_invoice_id',`:

```typescript
        depositCreditedToInvoiceId: 'deposit_credited_to_invoice_id',
        // §6 Time-to-Cash. Migration 095.
        moneyState: 'money_state',
        updatedAt: 'updated_at',
```

(The `INSERT` in `create` does **not** need a new placeholder — like the deposit columns, `money_state` relies on its column `DEFAULT`, and `createJob` produces exactly that default.)

- [ ] **Step 7: Add the migration**

In `packages/api/src/db/schema.ts`, find the `'094_add_held_appointment_fields'` entry — it is the last entry in the `MIGRATIONS` object, ending with a `` ` `` then `,` then a line with just `};`. Add a new entry immediately after it (before the closing `};`):

```typescript
  '094_add_held_appointment_fields': `
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS hold_pending_approval BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS hold_expiry_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_appointments_hold_expiry
      ON appointments(tenant_id, hold_expiry_at)
      WHERE hold_pending_approval = true;
  `,
  '095_jobs_money_state': `
    -- §6 Time-to-Cash. Denormalized money-state rollup for each job:
    -- no_estimate -> estimate_sent -> estimate_accepted -> invoiced ->
    -- paid, with overdue as an escalation of invoiced. Maintained by
    -- refreshJobMoneyState (app layer) on every estimate/invoice/payment
    -- mutation and by the overdue-invoice sweep. Idempotent: NOT NULL
    -- DEFAULT so legacy rows backfill to 'no_estimate'. The index serves
    -- the §8 money dashboard's per-state rollups.
    ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS money_state TEXT NOT NULL DEFAULT 'no_estimate';
    CREATE INDEX IF NOT EXISTS idx_jobs_money_state
      ON jobs(tenant_id, money_state);
  `,
};
```

- [ ] **Step 8: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit code 0.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/jobs/job.ts packages/api/src/jobs/pg-job.ts packages/api/src/db/schema.ts packages/api/test/jobs/job-money-state.test.ts
git commit -m "feat(api): add denormalized money_state to the job model"
```

---

## Task 2: `computeJobMoneyState` pure precedence function

**Files:**
- Create: `packages/api/src/jobs/job-money-state.ts`
- Test: `packages/api/test/jobs/job-money-state.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/api/test/jobs/job-money-state.test.ts` (keep the existing `describe` block; add these imports at the top of the file and the new `describe` at the end):

Add to the imports at the top:

```typescript
import { computeJobMoneyState } from '../../src/jobs/job-money-state';
import type { Estimate, EstimateStatus } from '../../src/estimates/estimate';
import type { Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import type { DocumentTotals } from '../../src/shared/billing-engine';
```

Append at the end of the file:

```typescript
const ZERO_TOTALS: DocumentTotals = {
  subtotalCents: 0,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 0,
  taxCents: 0,
  totalCents: 0,
};

function makeEstimate(status: EstimateStatus, jobId = 'job-1'): Estimate {
  return {
    id: `est-${status}-${Math.random()}`,
    tenantId: 't1',
    jobId,
    estimateNumber: 'EST-0001',
    status,
    lineItems: [],
    totals: ZERO_TOTALS,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeInvoice(
  status: InvoiceStatus,
  opts: { jobId?: string; dueDate?: Date } = {},
): Invoice {
  return {
    id: `inv-${status}-${Math.random()}`,
    tenantId: 't1',
    jobId: opts.jobId ?? 'job-1',
    invoiceNumber: 'INV-0001',
    status,
    lineItems: [],
    totals: ZERO_TOTALS,
    amountPaidCents: 0,
    amountDueCents: 0,
    dueDate: opts.dueDate,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('computeJobMoneyState', () => {
  const now = new Date('2026-05-14T12:00:00Z');
  const past = new Date('2026-05-01T00:00:00Z');
  const future = new Date('2026-06-01T00:00:00Z');

  it('returns no_estimate for a job with nothing', () => {
    expect(computeJobMoneyState([], [], now)).toBe('no_estimate');
  });

  it('ignores draft estimates', () => {
    expect(computeJobMoneyState([makeEstimate('draft')], [], now)).toBe('no_estimate');
  });

  it('ignores rejected and expired estimates', () => {
    expect(
      computeJobMoneyState([makeEstimate('rejected'), makeEstimate('expired')], [], now),
    ).toBe('no_estimate');
  });

  it('returns estimate_sent for a sent estimate', () => {
    expect(computeJobMoneyState([makeEstimate('sent')], [], now)).toBe('estimate_sent');
  });

  it('returns estimate_accepted for an accepted estimate', () => {
    expect(computeJobMoneyState([makeEstimate('accepted')], [], now)).toBe(
      'estimate_accepted',
    );
  });

  it('accepted outranks sent', () => {
    expect(
      computeJobMoneyState([makeEstimate('sent'), makeEstimate('accepted')], [], now),
    ).toBe('estimate_accepted');
  });

  it('ignores draft, void and canceled invoices', () => {
    expect(
      computeJobMoneyState(
        [],
        [makeInvoice('draft'), makeInvoice('void'), makeInvoice('canceled')],
        now,
      ),
    ).toBe('no_estimate');
  });

  it('returns invoiced for an open invoice with no due date', () => {
    expect(computeJobMoneyState([], [makeInvoice('open')], now)).toBe('invoiced');
  });

  it('returns invoiced for an open invoice not yet due', () => {
    expect(
      computeJobMoneyState([], [makeInvoice('open', { dueDate: future })], now),
    ).toBe('invoiced');
  });

  it('returns overdue for an open invoice past its due date', () => {
    expect(
      computeJobMoneyState([], [makeInvoice('open', { dueDate: past })], now),
    ).toBe('overdue');
  });

  it('returns overdue for a partially_paid invoice past its due date', () => {
    expect(
      computeJobMoneyState([], [makeInvoice('partially_paid', { dueDate: past })], now),
    ).toBe('overdue');
  });

  it('returns paid when the only invoice is paid', () => {
    expect(computeJobMoneyState([], [makeInvoice('paid')], now)).toBe('paid');
  });

  it('a paid invoice plus an open one is still invoiced (money outstanding)', () => {
    expect(
      computeJobMoneyState([], [makeInvoice('paid'), makeInvoice('open')], now),
    ).toBe('invoiced');
  });

  it('a paid invoice plus an overdue one is overdue', () => {
    expect(
      computeJobMoneyState(
        [],
        [makeInvoice('paid'), makeInvoice('open', { dueDate: past })],
        now,
      ),
    ).toBe('overdue');
  });

  it('invoice states outrank estimate states', () => {
    expect(
      computeJobMoneyState([makeEstimate('accepted')], [makeInvoice('open')], now),
    ).toBe('invoiced');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/jobs/job-money-state.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/jobs/job-money-state"` (the module does not exist yet).

- [ ] **Step 3: Create the module with `computeJobMoneyState`**

Create `packages/api/src/jobs/job-money-state.ts`:

```typescript
/**
 * §6 Time-to-Cash — the denormalized job money-state rollup.
 *
 * IMPORTANT: estimate/invoice/job modules are imported `import type` only
 * (erased at compile time). The single value import is `createAuditEvent`
 * from audit/audit — so the runtime import graph is
 * `estimate.ts -> job-money-state.ts -> audit/audit`, with no cycle even
 * though those modules import `refreshJobMoneyStateSafe` back from here.
 */
import type { Estimate } from '../estimates/estimate';
import type { Invoice } from '../invoices/invoice';
import type { JobMoneyState } from './job';

/**
 * Pure precedence function: given all of a job's estimates and invoices,
 * return the single money-state that best describes it. Highest-priority
 * match wins:
 *
 *   overdue           — an unpaid invoice is past its due date
 *   invoiced          — an unpaid invoice exists (none overdue)
 *   paid              — every invoice that exists is fully paid
 *   estimate_accepted — the customer accepted an estimate
 *   estimate_sent     — an estimate was sent, not yet accepted
 *   no_estimate       — nothing above matched
 *
 * "Still owes money" (invoiced/overdue) outranks `paid` because a second
 * invoice or a partial payment means money is outstanding. Invoice states
 * outrank estimate states. Ignored: draft/void/canceled invoices and
 * draft/ready_for_review/rejected/expired estimates.
 */
export function computeJobMoneyState(
  estimates: readonly Estimate[],
  invoices: readonly Invoice[],
  now: Date,
): JobMoneyState {
  const unpaidInvoices = invoices.filter(
    (i) => i.status === 'open' || i.status === 'partially_paid',
  );

  const hasOverdue = unpaidInvoices.some(
    (i) => i.dueDate !== undefined && i.dueDate.getTime() < now.getTime(),
  );
  if (hasOverdue) return 'overdue';

  if (unpaidInvoices.length > 0) return 'invoiced';

  if (invoices.some((i) => i.status === 'paid')) return 'paid';

  if (estimates.some((e) => e.status === 'accepted')) return 'estimate_accepted';

  if (estimates.some((e) => e.status === 'sent')) return 'estimate_sent';

  return 'no_estimate';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/jobs/job-money-state.test.ts`
Expected: PASS — the field-default test plus all 15 `computeJobMoneyState` cases.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/jobs/job-money-state.ts packages/api/test/jobs/job-money-state.test.ts
git commit -m "feat(api): add computeJobMoneyState precedence function"
```

---

## Task 3: `refreshJobMoneyState` + `refreshJobMoneyStateSafe`

**Files:**
- Modify: `packages/api/src/jobs/job-money-state.ts`
- Test: `packages/api/test/jobs/job-money-state.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/api/test/jobs/job-money-state.test.ts`, extend the existing imports. Change the line:

```typescript
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
```

to:

```typescript
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
```

and change:

```typescript
import { computeJobMoneyState } from '../../src/jobs/job-money-state';
```

to:

```typescript
import {
  computeJobMoneyState,
  refreshJobMoneyState,
  refreshJobMoneyStateSafe,
} from '../../src/jobs/job-money-state';
```

Append this `describe` block at the end of the file:

```typescript
describe('refreshJobMoneyState', () => {
  async function setup() {
    const jobRepo = new InMemoryJobRepository();
    const estimateRepo = new InMemoryEstimateRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    return { jobRepo, estimateRepo, invoiceRepo, auditRepo, job };
  }

  it('no-ops when the recomputed state equals the stored state', async () => {
    const { jobRepo, estimateRepo, invoiceRepo, auditRepo, job } = await setup();
    const result = await refreshJobMoneyState('t1', job.id, 'u1', {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });
    expect(result.changed).toBe(false);
    expect(result.current).toBe('no_estimate');
  });

  it('persists the new state and emits an audit event on a transition', async () => {
    const { jobRepo, estimateRepo, invoiceRepo, auditRepo, job } = await setup();
    await estimateRepo.create(makeEstimate('sent', job.id));

    const result = await refreshJobMoneyState('t1', job.id, 'u1', {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });

    expect(result.changed).toBe(true);
    expect(result.previous).toBe('no_estimate');
    expect(result.current).toBe('estimate_sent');

    const reloaded = await jobRepo.findById('t1', job.id);
    expect(reloaded!.moneyState).toBe('estimate_sent');

    const events = await auditRepo.findByEntity('t1', 'job', job.id);
    const moneyEvent = events.find((e) => e.eventType === 'job.money_state_changed');
    expect(moneyEvent).toBeDefined();
    expect(moneyEvent!.metadata).toMatchObject({ from: 'no_estimate', to: 'estimate_sent' });
  });

  it('a second refresh after the transition is a no-op', async () => {
    const { jobRepo, estimateRepo, invoiceRepo, auditRepo, job } = await setup();
    await estimateRepo.create(makeEstimate('sent', job.id));
    await refreshJobMoneyState('t1', job.id, 'u1', { jobRepo, estimateRepo, invoiceRepo, auditRepo });

    const second = await refreshJobMoneyState('t1', job.id, 'u1', {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });
    expect(second.changed).toBe(false);
    expect(second.current).toBe('estimate_sent');
  });

  it('returns a null no-op result for a missing job', async () => {
    const { jobRepo, estimateRepo, invoiceRepo, auditRepo } = await setup();
    const result = await refreshJobMoneyState('t1', 'does-not-exist', 'u1', {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });
    expect(result.job).toBeNull();
    expect(result.changed).toBe(false);
  });

  it('refreshJobMoneyStateSafe swallows errors and returns a no-op result', async () => {
    const { estimateRepo, invoiceRepo, auditRepo, job } = await setup();
    const throwingJobRepo = {
      findById: async () => {
        throw new Error('db down');
      },
    } as unknown as InMemoryJobRepository;

    const result = await refreshJobMoneyStateSafe('t1', job.id, 'u1', {
      jobRepo: throwingJobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
    });
    expect(result.changed).toBe(false);
    expect(result.job).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/jobs/job-money-state.test.ts`
Expected: FAIL — `refreshJobMoneyState is not a function` / import error (only `computeJobMoneyState` is exported so far).

- [ ] **Step 3: Add the orchestrators to `job-money-state.ts`**

In `packages/api/src/jobs/job-money-state.ts`, extend the imports. Change:

```typescript
import type { Estimate } from '../estimates/estimate';
import type { Invoice } from '../invoices/invoice';
import type { JobMoneyState } from './job';
```

to:

```typescript
import type { Estimate, EstimateRepository } from '../estimates/estimate';
import type { Invoice, InvoiceRepository } from '../invoices/invoice';
import type { Job, JobMoneyState, JobRepository } from './job';
import type { Logger } from '../logging/logger';
import { AuditRepository, createAuditEvent } from '../audit/audit';
```

Then append to the file (after `computeJobMoneyState`):

```typescript
export interface RefreshJobMoneyStateDeps {
  jobRepo: JobRepository;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  /** When provided, a `job.money_state_changed` event is emitted on every transition. */
  auditRepo?: AuditRepository;
}

export interface RefreshJobMoneyStateResult {
  job: Job | null;
  changed: boolean;
  previous: JobMoneyState;
  current: JobMoneyState;
}

/**
 * Recompute and persist a job's money-state from its current estimates
 * and invoices. No-ops (changed: false) when the recomputed state equals
 * the stored one. On a real transition it persists the new state and —
 * when `auditRepo` is wired — emits a `job.money_state_changed` event.
 *
 * Can throw (repo failures propagate). Route/webhook callers should use
 * `refreshJobMoneyStateSafe`.
 */
export async function refreshJobMoneyState(
  tenantId: string,
  jobId: string,
  actorId: string,
  deps: RefreshJobMoneyStateDeps,
): Promise<RefreshJobMoneyStateResult> {
  const job = await deps.jobRepo.findById(tenantId, jobId);
  if (!job) {
    return { job: null, changed: false, previous: 'no_estimate', current: 'no_estimate' };
  }

  const previous: JobMoneyState = job.moneyState ?? 'no_estimate';
  const [estimates, invoices] = await Promise.all([
    deps.estimateRepo.findByJob(tenantId, jobId),
    deps.invoiceRepo.findByJob(tenantId, jobId),
  ]);
  const current = computeJobMoneyState(estimates, invoices, new Date());

  if (current === previous) {
    return { job, changed: false, previous, current };
  }

  const updated = await deps.jobRepo.update(tenantId, jobId, {
    moneyState: current,
    updatedAt: new Date(),
  });

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'system',
        eventType: 'job.money_state_changed',
        entityType: 'job',
        entityId: jobId,
        metadata: { from: previous, to: current },
      }),
    );
  }

  return { job: updated, changed: true, previous, current };
}

/**
 * Non-throwing wrapper for route/webhook/worker call sites: a money-state
 * rollup failure must never bounce the underlying mutation (the
 * estimate/invoice/payment write already succeeded). Logs and returns a
 * no-op result on any error.
 */
export async function refreshJobMoneyStateSafe(
  tenantId: string,
  jobId: string,
  actorId: string,
  deps: RefreshJobMoneyStateDeps,
  logger?: Logger,
): Promise<RefreshJobMoneyStateResult> {
  try {
    return await refreshJobMoneyState(tenantId, jobId, actorId, deps);
  } catch (err) {
    logger?.warn('refreshJobMoneyState failed', {
      tenantId,
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { job: null, changed: false, previous: 'no_estimate', current: 'no_estimate' };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/jobs/job-money-state.test.ts`
Expected: PASS — all field-default, `computeJobMoneyState`, and `refreshJobMoneyState` cases.

- [ ] **Step 5: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit code 0.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/jobs/job-money-state.ts packages/api/test/jobs/job-money-state.test.ts
git commit -m "feat(api): add refreshJobMoneyState rollup orchestrator"
```

---

## Task 4: Thread the refresh through the estimate/invoice domain functions

This task adds an optional `moneyStateDeps?: RefreshJobMoneyStateDeps` parameter to the four money-mutation choke-point functions. When the param is omitted (every existing caller), behavior is byte-for-byte unchanged.

**Files:**
- Modify: `packages/api/src/invoices/payment.ts`
- Modify: `packages/api/src/invoices/invoice.ts`
- Modify: `packages/api/src/estimates/estimate.ts`
- Test: `packages/api/test/jobs/job-money-state-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/jobs/job-money-state-wiring.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import {
  InMemoryInvoiceRepository,
  issueInvoice,
  transitionInvoiceStatus,
  Invoice,
  InvoiceStatus,
} from '../../src/invoices/invoice';
import {
  InMemoryEstimateRepository,
  transitionEstimateStatus,
  Estimate,
  EstimateStatus,
} from '../../src/estimates/estimate';
import { InMemoryPaymentRepository, recordPayment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { DocumentTotals } from '../../src/shared/billing-engine';
import type { RefreshJobMoneyStateDeps } from '../../src/jobs/job-money-state';

const ZERO_TOTALS: DocumentTotals = {
  subtotalCents: 0,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 0,
  taxCents: 0,
  totalCents: 0,
};

function makeEstimate(jobId: string, status: EstimateStatus): Estimate {
  return {
    id: uuidv4(),
    tenantId: 't1',
    jobId,
    estimateNumber: 'EST-0001',
    status,
    lineItems: [],
    totals: ZERO_TOTALS,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeInvoice(
  jobId: string,
  status: InvoiceStatus,
  opts: { totalCents?: number; amountDueCents?: number } = {},
): Invoice {
  const totalCents = opts.totalCents ?? 0;
  return {
    id: uuidv4(),
    tenantId: 't1',
    jobId,
    invoiceNumber: 'INV-0001',
    status,
    lineItems: [],
    totals: {
      ...ZERO_TOTALS,
      subtotalCents: totalCents,
      taxableSubtotalCents: totalCents,
      totalCents,
    },
    amountPaidCents: 0,
    amountDueCents: opts.amountDueCents ?? totalCents,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function setup() {
  const jobRepo = new InMemoryJobRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const paymentRepo = new InMemoryPaymentRepository();
  const auditRepo = new InMemoryAuditRepository();
  const job = await createJob(
    { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
    jobRepo,
  );
  const deps: RefreshJobMoneyStateDeps = { jobRepo, estimateRepo, invoiceRepo, auditRepo };
  return { jobRepo, estimateRepo, invoiceRepo, paymentRepo, auditRepo, job, deps };
}

describe('money-state threading through domain functions', () => {
  it('issueInvoice flips the job to invoiced when given deps', async () => {
    const { jobRepo, invoiceRepo, job, deps } = await setup();
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'draft', { totalCents: 10000 }));

    await issueInvoice('t1', invoice.id, 30, invoiceRepo, deps);

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('invoiced');
  });

  it('issueInvoice leaves money-state untouched when given no deps', async () => {
    const { jobRepo, invoiceRepo, job } = await setup();
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'draft', { totalCents: 10000 }));

    await issueInvoice('t1', invoice.id, 30, invoiceRepo);

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('no_estimate');
  });

  it('recordPayment flips the job to paid when the invoice is fully paid', async () => {
    const { jobRepo, invoiceRepo, paymentRepo, job, deps } = await setup();
    const invoice = await invoiceRepo.create(
      makeInvoice(job.id, 'open', { totalCents: 10000, amountDueCents: 10000 }),
    );

    await recordPayment(
      {
        tenantId: 't1',
        invoiceId: invoice.id,
        amountCents: 10000,
        method: 'credit_card',
        processedBy: 'u1',
      },
      invoiceRepo,
      paymentRepo,
      deps,
    );

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('paid');
  });

  it('transitionInvoiceStatus flips the job to paid', async () => {
    const { jobRepo, invoiceRepo, job, deps } = await setup();
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'open', { totalCents: 10000 }));

    await transitionInvoiceStatus('t1', invoice.id, 'paid', invoiceRepo, deps);

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('paid');
  });

  it('transitionEstimateStatus flips the job to estimate_sent', async () => {
    const { jobRepo, estimateRepo, job, deps } = await setup();
    const estimate = await estimateRepo.create(makeEstimate(job.id, 'draft'));

    await transitionEstimateStatus('t1', estimate.id, 'sent', estimateRepo, deps);

    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('estimate_sent');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/jobs/job-money-state-wiring.test.ts`
Expected: FAIL — TypeScript errors: `issueInvoice` / `recordPayment` / `transitionInvoiceStatus` / `transitionEstimateStatus` expect fewer arguments than were passed.

- [ ] **Step 3: Thread the param through `recordPayment`**

In `packages/api/src/invoices/payment.ts`, add this import below the existing imports at the top of the file:

```typescript
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';
```

Change the `recordPayment` signature from:

```typescript
export async function recordPayment(
  input: RecordPaymentInput,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository
): Promise<{ payment: Payment; invoice: Invoice }> {
```

to:

```typescript
export async function recordPayment(
  input: RecordPaymentInput,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
): Promise<{ payment: Payment; invoice: Invoice }> {
```

Then replace the final `return` statement:

```typescript
  return { payment, invoice: updatedInvoice! };
```

with:

```typescript
  // §6 Time-to-Cash. Roll the job's money-state forward (best-effort —
  // the payment + invoice writes already succeeded; a rollup failure
  // must not bounce them). No-op when the caller didn't wire the deps.
  if (moneyStateDeps) {
    await refreshJobMoneyStateSafe(
      input.tenantId,
      updatedInvoice!.jobId,
      input.processedBy,
      moneyStateDeps,
    );
  }

  return { payment, invoice: updatedInvoice! };
```

- [ ] **Step 4: Thread the param through `issueInvoice` and `transitionInvoiceStatus`**

In `packages/api/src/invoices/invoice.ts`, add this import below the existing imports at the top of the file:

```typescript
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';
```

Replace the entire `issueInvoice` function with:

```typescript
export async function issueInvoice(
  tenantId: string,
  id: string,
  paymentTermDays: number,
  repository: InvoiceRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
): Promise<Invoice | null> {
  const invoice = await repository.findById(tenantId, id);
  if (!invoice) return null;

  if (!isValidInvoiceTransition(invoice.status, 'open')) {
    throw new ValidationError(`Invalid transition from ${invoice.status} to open`);
  }

  const issuedAt = new Date();
  const dueDate = calculateDueDate(issuedAt, paymentTermDays);

  const updated = await repository.update(tenantId, id, {
    status: 'open',
    issuedAt,
    dueDate,
    updatedAt: new Date(),
  });

  // §6 Time-to-Cash. Best-effort job money-state rollup.
  if (updated && moneyStateDeps) {
    await refreshJobMoneyStateSafe(tenantId, updated.jobId, 'system', moneyStateDeps);
  }

  return updated;
}
```

Replace the entire `transitionInvoiceStatus` function with:

```typescript
export async function transitionInvoiceStatus(
  tenantId: string,
  id: string,
  newStatus: InvoiceStatus,
  repository: InvoiceRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
): Promise<Invoice | null> {
  const invoice = await repository.findById(tenantId, id);
  if (!invoice) return null;

  if (!isValidInvoiceTransition(invoice.status, newStatus)) {
    throw new ValidationError(`Invalid transition from ${invoice.status} to ${newStatus}`);
  }

  const updated = await repository.update(tenantId, id, {
    status: newStatus,
    updatedAt: new Date(),
  });

  // §6 Time-to-Cash. Best-effort job money-state rollup.
  if (updated && moneyStateDeps) {
    await refreshJobMoneyStateSafe(tenantId, updated.jobId, 'system', moneyStateDeps);
  }

  return updated;
}
```

- [ ] **Step 5: Thread the param through `transitionEstimateStatus`**

In `packages/api/src/estimates/estimate.ts`, add this import below the existing imports at the top of the file:

```typescript
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';
```

Replace the entire `transitionEstimateStatus` function with:

```typescript
export async function transitionEstimateStatus(
  tenantId: string,
  id: string,
  newStatus: EstimateStatus,
  repository: EstimateRepository,
  moneyStateDeps?: RefreshJobMoneyStateDeps,
): Promise<Estimate | null> {
  const estimate = await repository.findById(tenantId, id);
  if (!estimate) return null;

  if (!isValidEstimateTransition(estimate.status, newStatus)) {
    throw new ValidationError(`Invalid transition from ${estimate.status} to ${newStatus}`);
  }

  const updated = await repository.update(tenantId, id, {
    status: newStatus,
    updatedAt: new Date(),
  });

  // §6 Time-to-Cash. Best-effort job money-state rollup.
  if (updated && moneyStateDeps) {
    await refreshJobMoneyStateSafe(tenantId, updated.jobId, 'system', moneyStateDeps);
  }

  return updated;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/jobs/job-money-state-wiring.test.ts`
Expected: PASS — all five threading cases.

- [ ] **Step 7: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit code 0.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/invoices/payment.ts packages/api/src/invoices/invoice.ts packages/api/src/estimates/estimate.ts packages/api/test/jobs/job-money-state-wiring.test.ts
git commit -m "feat(api): thread money-state rollup through estimate/invoice domain functions"
```

---

## Task 5: Wire the routers, the Stripe webhook, and `app.ts`

The domain functions now *accept* refresh deps; this task makes the routers and the webhook actually *supply* them, and adds the one explicit refresh the estimate `/send` route needs (its status change happens inside `SendService`, not a threadable function).

**Files:**
- Modify: `packages/api/src/routes/invoices.ts`
- Modify: `packages/api/src/routes/estimates.ts`
- Modify: `packages/api/src/webhooks/routes.ts`
- Modify: `packages/api/src/app.ts`
- Modify: `packages/api/test/routes/test-app.ts`
- Test: `packages/api/test/routes/job-money-state.route.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/api/test/routes/job-money-state.route.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, TestApp, TEST_TENANT_ID, TEST_USER_ID } from './test-app';
import { v4 as uuidv4 } from 'uuid';

describe('job money-state — route wiring', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await buildTestApp();
  });

  async function seedJob(): Promise<string> {
    const job = await ctx.jobRepo.create({
      id: uuidv4(),
      tenantId: TEST_TENANT_ID,
      customerId: uuidv4(),
      locationId: uuidv4(),
      jobNumber: 'JOB-0001',
      summary: 'AC repair',
      status: 'new',
      priority: 'normal',
      moneyState: 'no_estimate',
      createdBy: TEST_USER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return job.id;
  }

  it('issuing an invoice flips the job money-state to invoiced', async () => {
    const jobId = await seedJob();
    const created = await request(ctx.app)
      .post('/api/invoices')
      .send({
        jobId,
        lineItems: [
          {
            id: uuidv4(),
            description: 'Labor',
            quantity: 1,
            unitPriceCents: 12000,
            totalCents: 12000,
            sortOrder: 0,
            taxable: true,
          },
        ],
      });
    expect(created.status).toBe(201);

    const issued = await request(ctx.app)
      .post(`/api/invoices/${created.body.id}/issue`)
      .send({ paymentTermDays: 30 });
    expect(issued.status).toBe(200);

    const job = await ctx.jobRepo.findById(TEST_TENANT_ID, jobId);
    expect(job!.moneyState).toBe('invoiced');
  });

  it('transitioning an estimate to sent flips the job money-state to estimate_sent', async () => {
    const jobId = await seedJob();
    const created = await request(ctx.app)
      .post('/api/estimates')
      .send({
        jobId,
        lineItems: [
          {
            id: uuidv4(),
            description: 'Diagnostic',
            quantity: 1,
            unitPriceCents: 8000,
            totalCents: 8000,
            sortOrder: 0,
            taxable: true,
          },
        ],
      });
    expect(created.status).toBe(201);

    const transitioned = await request(ctx.app)
      .post(`/api/estimates/${created.body.id}/transition`)
      .send({ status: 'sent' });
    expect(transitioned.status).toBe(200);

    const job = await ctx.jobRepo.findById(TEST_TENANT_ID, jobId);
    expect(job!.moneyState).toBe('estimate_sent');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/routes/job-money-state.route.test.ts`
Expected: FAIL — both assertions get `'no_estimate'` (the routers don't pass refresh deps yet, so the domain functions skip the rollup).

- [ ] **Step 3: Wire `createInvoiceRouter`**

In `packages/api/src/routes/invoices.ts`:

Add `EstimateRepository` to the estimates import and add the money-state import. Change:

```typescript
import { Job, JobRepository } from '../jobs/job';
```

to:

```typescript
import { Job, JobRepository } from '../jobs/job';
import { EstimateRepository } from '../estimates/estimate';
import { RefreshJobMoneyStateDeps } from '../jobs/job-money-state';
```

Change the `createInvoiceRouter` signature from:

```typescript
export function createInvoiceRouter(
  invoiceRepo: InvoiceRepository,
  settingsRepo: SettingsRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership,
  paymentRepo?: PaymentRepository,
  sendService?: SendService,
  // Tier 4 (Deposit rules — PR 3c). Optional so legacy harnesses
  // without a job repo still build the router; deposit credit only
  // fires when both jobRepo + paymentRepo are wired.
  jobRepo?: JobRepository,
): Router {
  const router = Router();
```

to:

```typescript
export function createInvoiceRouter(
  invoiceRepo: InvoiceRepository,
  settingsRepo: SettingsRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership,
  paymentRepo?: PaymentRepository,
  sendService?: SendService,
  // Tier 4 (Deposit rules — PR 3c). Optional so legacy harnesses
  // without a job repo still build the router; deposit credit only
  // fires when both jobRepo + paymentRepo are wired.
  jobRepo?: JobRepository,
  // §6 Time-to-Cash. Optional so legacy harnesses still build; the
  // money-state rollup fires only when both jobRepo + estimateRepo
  // are wired.
  estimateRepo?: EstimateRepository,
): Router {
  const router = Router();

  // §6 Time-to-Cash. Built once at factory time — the rollup needs the
  // job, estimate and invoice repos plus the audit repo for the
  // job.money_state_changed event.
  const refreshDeps: RefreshJobMoneyStateDeps | undefined =
    jobRepo && estimateRepo
      ? { jobRepo, estimateRepo, invoiceRepo, auditRepo }
      : undefined;
```

In the `/:id/issue` handler, change:

```typescript
        const result = await issueInvoice(req.auth!.tenantId, req.params.id, paymentTermDays, invoiceRepo);
```

to:

```typescript
        const result = await issueInvoice(
          req.auth!.tenantId,
          req.params.id,
          paymentTermDays,
          invoiceRepo,
          refreshDeps,
        );
```

In the `/:id/payment` handler, change:

```typescript
        const result = await recordPayment(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            invoiceId: req.params.id,
            processedBy: req.auth!.userId,
          },
          invoiceRepo,
          paymentRepo
        );
```

to:

```typescript
        const result = await recordPayment(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            invoiceId: req.params.id,
            processedBy: req.auth!.userId,
          },
          invoiceRepo,
          paymentRepo,
          refreshDeps,
        );
```

In the `/:id/transition` handler, change:

```typescript
        const result = await transitionInvoiceStatus(req.auth!.tenantId, req.params.id, status, invoiceRepo);
```

to:

```typescript
        const result = await transitionInvoiceStatus(
          req.auth!.tenantId,
          req.params.id,
          status,
          invoiceRepo,
          refreshDeps,
        );
```

- [ ] **Step 4: Wire `createEstimateRouter`**

In `packages/api/src/routes/estimates.ts`:

Add the imports below the existing `EstimateTaskHandler` import:

```typescript
import { JobRepository } from '../jobs/job';
import { InvoiceRepository } from '../invoices/invoice';
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';
```

Change the `createEstimateRouter` signature from:

```typescript
export function createEstimateRouter(
  estimateRepo: EstimateRepository,
  settingsRepo: SettingsRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership,
  sendService?: SendService,
  aiDeps?: EstimateAIDeps
): Router {
  const router = Router();
```

to:

```typescript
export function createEstimateRouter(
  estimateRepo: EstimateRepository,
  settingsRepo: SettingsRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership,
  sendService?: SendService,
  aiDeps?: EstimateAIDeps,
  // §6 Time-to-Cash. Optional so legacy harnesses still build; the
  // money-state rollup fires only when both repos are wired.
  moneyStateDeps?: { jobRepo: JobRepository; invoiceRepo: InvoiceRepository },
): Router {
  const router = Router();

  // §6 Time-to-Cash. estimateRepo + auditRepo are already in scope;
  // the caller supplies the job + invoice repos.
  const refreshDeps: RefreshJobMoneyStateDeps | undefined = moneyStateDeps
    ? {
        jobRepo: moneyStateDeps.jobRepo,
        estimateRepo,
        invoiceRepo: moneyStateDeps.invoiceRepo,
        auditRepo,
      }
    : undefined;
```

In the `/:id/transition` handler, change:

```typescript
        const result = await transitionEstimateStatus(req.auth!.tenantId, req.params.id, status, estimateRepo);
```

to:

```typescript
        const result = await transitionEstimateStatus(
          req.auth!.tenantId,
          req.params.id,
          status,
          estimateRepo,
          refreshDeps,
        );
```

In the `/:id/send` handler, immediately after `const result = await sendService.sendEstimate({ ... });` and before `res.status(202).json(result);`, add:

```typescript
        // §6 Time-to-Cash. sendEstimate transitions the estimate to
        // 'sent' inside SendService (not via transitionEstimateStatus),
        // so the rollup is triggered explicitly here. Best-effort.
        if (refreshDeps) {
          const sent = await estimateRepo.findById(req.auth!.tenantId, req.params.id);
          if (sent) {
            await refreshJobMoneyStateSafe(
              req.auth!.tenantId,
              sent.jobId,
              req.auth!.userId,
              refreshDeps,
            );
          }
        }
        res.status(202).json(result);
```

- [ ] **Step 5: Wire the Stripe webhook**

In `packages/api/src/webhooks/routes.ts`:

Add `EstimateRepository` and the money-state import alongside the existing imports at the top:

```typescript
import { EstimateRepository } from '../estimates/estimate';
import { RefreshJobMoneyStateDeps } from '../jobs/job-money-state';
```

In the `WebhookRouterDeps` interface, add the field right after the `jobRepo?: JobRepository;` field:

```typescript
  jobRepo?: JobRepository;
  /**
   * §6 Time-to-Cash. When wired alongside jobRepo + invoiceRepo, the
   * Stripe checkout webhook rolls the linked job's money-state forward
   * after recording the payment. Optional so legacy harnesses build.
   */
  estimateRepo?: EstimateRepository;
```

In the Stripe handler, immediately after the guard `if (!deps.invoiceRepo || !deps.paymentRepo) { ... }` block (and before the `try { await recordPayment(...) }` block), add:

```typescript
        // §6 Time-to-Cash. Refresh deps for the post-payment job
        // money-state rollup. Undefined unless all three repos are
        // wired — recordPayment then skips the rollup cleanly.
        const moneyStateDeps: RefreshJobMoneyStateDeps | undefined =
          deps.jobRepo && deps.estimateRepo
            ? {
                jobRepo: deps.jobRepo,
                estimateRepo: deps.estimateRepo,
                invoiceRepo: deps.invoiceRepo,
                auditRepo: deps.auditRepo,
              }
            : undefined;
```

Then, in the same block, change **both** `recordPayment(...)` calls — the primary one and the overpayment-retry one — to pass `moneyStateDeps` as the final argument. The primary call becomes:

```typescript
          await recordPayment(
            {
              tenantId,
              invoiceId,
              amountCents: amountTotal,
              method: 'credit_card',
              providerReference: 'stripe_checkout',
              processedBy: 'stripe_webhook',
            },
            deps.invoiceRepo,
            deps.paymentRepo,
            moneyStateDeps,
          );
```

and the overpayment-retry call (inside the `if (!invoice || invoice.amountDueCents <= 0) { ... } else { ... }` branch) becomes:

```typescript
                await recordPayment(
                  {
                    tenantId,
                    invoiceId,
                    amountCents: invoice.amountDueCents,
                    method: 'credit_card',
                    providerReference: 'stripe_checkout',
                    processedBy: 'stripe_webhook',
                  },
                  deps.invoiceRepo,
                  deps.paymentRepo,
                  moneyStateDeps,
                );
```

- [ ] **Step 6: Wire `app.ts`**

In `packages/api/src/app.ts`:

Construct a `webhookEstimateRepo` alongside the other webhook repos. Find the line (~531):

```typescript
  const webhookInvoiceRepo = pool ? new PgInvoiceRepository(pool) : new InMemoryInvoiceRepository();
```

and add immediately after it:

```typescript
  const webhookEstimateRepo = pool ? new PgEstimateRepository(pool) : new InMemoryEstimateRepository();
```

In the `createWebhookRouter(config, { ... })` deps object, add `estimateRepo: webhookEstimateRepo,` immediately after the `invoiceRepo: webhookInvoiceRepo,` line:

```typescript
      invoiceRepo: webhookInvoiceRepo,
      estimateRepo: webhookEstimateRepo,
      paymentRepo: webhookPaymentRepo,
```

Update the `createEstimateRouter` call (~line 1869) from:

```typescript
    createEstimateRouter(estimateRepo, settingsRepo, auditRepo, ownership, sendService, {
      gateway: llmGateway,
      proposalRepo,
    }),
```

to:

```typescript
    createEstimateRouter(
      estimateRepo,
      settingsRepo,
      auditRepo,
      ownership,
      sendService,
      { gateway: llmGateway, proposalRepo },
      { jobRepo, invoiceRepo },
    ),
```

Update the `createInvoiceRouter` call (~line 1874) from:

```typescript
  app.use('/api/invoices', createInvoiceRouter(invoiceRepo, settingsRepo, auditRepo, ownership, paymentRepo, sendService, jobRepo));
```

to:

```typescript
  app.use('/api/invoices', createInvoiceRouter(invoiceRepo, settingsRepo, auditRepo, ownership, paymentRepo, sendService, jobRepo, estimateRepo));
```

- [ ] **Step 7: Wire `test-app.ts`**

In `packages/api/test/routes/test-app.ts`, update the two router mounts. Change:

```typescript
  app.use('/api/estimates', createEstimateRouter(estimateRepo, settingsRepo, auditRepo, ownership));
  app.use('/api/invoices', createInvoiceRouter(invoiceRepo, settingsRepo, auditRepo, ownership, paymentRepo));
```

to:

```typescript
  app.use(
    '/api/estimates',
    createEstimateRouter(estimateRepo, settingsRepo, auditRepo, ownership, undefined, undefined, {
      jobRepo,
      invoiceRepo,
    }),
  );
  app.use(
    '/api/invoices',
    createInvoiceRouter(
      invoiceRepo,
      settingsRepo,
      auditRepo,
      ownership,
      paymentRepo,
      undefined,
      jobRepo,
      estimateRepo,
    ),
  );
```

- [ ] **Step 8: Run the integration test to verify it passes**

Run: `cd packages/api && npm test -- test/routes/job-money-state.route.test.ts`
Expected: PASS — both the invoice-issue and estimate-transition assertions.

- [ ] **Step 9: Run the existing estimate + invoice route suites to confirm no regression**

Run: `cd packages/api && npm test -- test/routes/estimates.route.test.ts test/routes/invoices.route.test.ts`
Expected: PASS — the appended router params are optional and existing callers are unaffected.

- [ ] **Step 10: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit code 0.

- [ ] **Step 11: Commit**

```bash
git add packages/api/src/routes/invoices.ts packages/api/src/routes/estimates.ts packages/api/src/webhooks/routes.ts packages/api/src/app.ts packages/api/test/routes/test-app.ts packages/api/test/routes/job-money-state.route.test.ts
git commit -m "feat(api): wire job money-state rollup into invoice/estimate routes and Stripe webhook"
```

---

## Task 6: Overdue-invoice detection worker

**Files:**
- Create: `packages/api/src/workers/overdue-invoice-worker.ts`
- Test: `packages/api/test/workers/overdue-invoice-worker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/workers/overdue-invoice-worker.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository, Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createLogger } from '../../src/logging/logger';
import {
  runOverdueInvoiceSweep,
  OverdueInvoiceWorkerDeps,
} from '../../src/workers/overdue-invoice-worker';
import type { DocumentTotals } from '../../src/shared/billing-engine';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-05-14T12:00:00Z');
const PAST = new Date('2026-05-01T00:00:00Z');
const FUTURE = new Date('2026-06-01T00:00:00Z');

const ZERO_TOTALS: DocumentTotals = {
  subtotalCents: 0,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 0,
  taxCents: 0,
  totalCents: 10000,
};

function makeInvoice(jobId: string, status: InvoiceStatus, dueDate: Date): Invoice {
  return {
    id: uuidv4(),
    tenantId: 't1',
    jobId,
    invoiceNumber: 'INV-0001',
    status,
    lineItems: [],
    totals: ZERO_TOTALS,
    amountPaidCents: 0,
    amountDueCents: 10000,
    dueDate,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('runOverdueInvoiceSweep', () => {
  let jobRepo: InMemoryJobRepository;
  let estimateRepo: InMemoryEstimateRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    estimateRepo = new InMemoryEstimateRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  function deps(listTenantIds: () => Promise<string[]>): OverdueInvoiceWorkerDeps {
    return {
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
      listTenantIds,
      logger,
      now: () => NOW,
    };
  }

  it('returns all-zero when there are no tenants', async () => {
    const result = await runOverdueInvoiceSweep(deps(async () => []));
    expect(result).toEqual({ tenants: 0, overdue: 0, failed: 0 });
  });

  it('flips a past-due open invoice job to overdue and emits invoice.overdue', async () => {
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    const invoice = await invoiceRepo.create(makeInvoice(job.id, 'open', PAST));

    const result = await runOverdueInvoiceSweep(deps(async () => ['t1']));

    expect(result).toEqual({ tenants: 1, overdue: 1, failed: 0 });
    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('overdue');

    const events = await auditRepo.findByEntity('t1', 'invoice', invoice.id);
    const overdueEvent = events.find((e) => e.eventType === 'invoice.overdue');
    expect(overdueEvent).toBeDefined();
    expect(overdueEvent!.metadata).toMatchObject({ jobId: job.id, amountDueCents: 10000 });
  });

  it('leaves a not-yet-due open invoice untouched', async () => {
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    await invoiceRepo.create(makeInvoice(job.id, 'open', FUTURE));

    const result = await runOverdueInvoiceSweep(deps(async () => ['t1']));

    expect(result.overdue).toBe(0);
    expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('no_estimate');
  });

  it('is idempotent — a second sweep emits no new event', async () => {
    const job = await createJob(
      { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    await invoiceRepo.create(makeInvoice(job.id, 'open', PAST));

    await runOverdueInvoiceSweep(deps(async () => ['t1']));
    const second = await runOverdueInvoiceSweep(deps(async () => ['t1']));

    expect(second.overdue).toBe(0);
  });

  it('isolates a tenant failure and keeps sweeping the rest', async () => {
    const job = await createJob(
      { tenantId: 't2', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    await invoiceRepo.create({ ...makeInvoice(job.id, 'open', PAST), tenantId: 't2' });

    // Repo that throws for tenant 't1' only.
    const flakyInvoiceRepo = {
      findByTenant: async (tenantId: string, options?: unknown) => {
        if (tenantId === 't1') throw new Error('db down for t1');
        return invoiceRepo.findByTenant(tenantId, options as never);
      },
      findByJob: invoiceRepo.findByJob.bind(invoiceRepo),
    } as unknown as InMemoryInvoiceRepository;

    const result = await runOverdueInvoiceSweep({
      jobRepo,
      estimateRepo,
      invoiceRepo: flakyInvoiceRepo,
      auditRepo,
      listTenantIds: async () => ['t1', 't2'],
      logger,
      now: () => NOW,
    });

    expect(result.tenants).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.overdue).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/workers/overdue-invoice-worker.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/workers/overdue-invoice-worker"` (the module does not exist yet).

- [ ] **Step 3: Create the worker**

Create `packages/api/src/workers/overdue-invoice-worker.ts`:

```typescript
/**
 * §6 Time-to-Cash — overdue-invoice sweeper.
 *
 * Mirrors the P0-009 execution-worker / recurring-agreements pattern: a
 * cross-tenant sweep that never lets one tenant's failure crash the loop.
 * For each tenant it finds unpaid invoices past their due date, refreshes
 * the linked job's money-state (which flips it to `overdue`), and emits an
 * `invoice.overdue` audit event the first time a job crosses into the
 * overdue state — §7's dunning layer listens for that event.
 *
 * The sweep cadence is owned by app.ts (a setInterval driver). Tests
 * exercise this function directly with in-memory repos and a fixed clock.
 */
import { Logger } from '../logging/logger';
import { JobRepository } from '../jobs/job';
import { EstimateRepository } from '../estimates/estimate';
import { InvoiceRepository } from '../invoices/invoice';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { refreshJobMoneyStateSafe } from '../jobs/job-money-state';

export interface OverdueInvoiceWorkerDeps {
  jobRepo: JobRepository;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  auditRepo: AuditRepository;
  /** Returns the list of tenant IDs to sweep. */
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

export async function runOverdueInvoiceSweep(
  deps: OverdueInvoiceWorkerDeps,
): Promise<{ tenants: number; overdue: number; failed: number }> {
  const now = deps.now ?? (() => new Date());

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Overdue-invoice sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, overdue: 0, failed: 0 };
  }

  let overdue = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const asOf = now();
      // Prefilter: unpaid invoices whose due date has passed. The
      // authoritative overdue decision is made by computeJobMoneyState
      // inside refreshJobMoneyState — this query just narrows the set.
      const candidates = [
        ...(await deps.invoiceRepo.findByTenant(tenantId, {
          status: 'open',
          toDueDate: asOf,
        })),
        ...(await deps.invoiceRepo.findByTenant(tenantId, {
          status: 'partially_paid',
          toDueDate: asOf,
        })),
      ];

      for (const invoice of candidates) {
        const result = await refreshJobMoneyStateSafe(
          tenantId,
          invoice.jobId,
          'overdue-invoice-worker',
          {
            jobRepo: deps.jobRepo,
            estimateRepo: deps.estimateRepo,
            invoiceRepo: deps.invoiceRepo,
            auditRepo: deps.auditRepo,
          },
          deps.logger,
        );

        // Emit invoice.overdue only on the transition INTO overdue, so a
        // re-run of the sweep doesn't re-fire the event: once the job is
        // `overdue`, refreshJobMoneyState reports changed:false.
        if (result.changed && result.current === 'overdue') {
          overdue++;
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: 'overdue-invoice-worker',
              actorRole: 'system',
              eventType: 'invoice.overdue',
              entityType: 'invoice',
              entityId: invoice.id,
              metadata: {
                jobId: invoice.jobId,
                dueDate: invoice.dueDate?.toISOString(),
                amountDueCents: invoice.amountDueCents,
              },
            }),
          );
        }
      }
    } catch (err) {
      // Mirror execution-worker.ts: one tenant's failure is logged and
      // swallowed so the sweep keeps going.
      failed++;
      deps.logger.warn('Overdue-invoice sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tenants: tenantIds.length, overdue, failed };
}
```

> Known limitation (acceptable for the launch MVP — a solo operator's job has at most one invoice): if a job is already `overdue` from invoice A and invoice B on the *same job* later goes overdue, no fresh `invoice.overdue` event fires for B, because the job's money-state is already `overdue` and `refreshJobMoneyState` reports `changed:false`. The job state stays correct; only the per-invoice event for B is skipped.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/workers/overdue-invoice-worker.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 5: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit code 0.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/workers/overdue-invoice-worker.ts packages/api/test/workers/overdue-invoice-worker.test.ts
git commit -m "feat(api): add overdue-invoice detection worker"
```

---

## Task 7: Schedule the worker in `app.ts` and run full verification

**Files:**
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Import the worker**

In `packages/api/src/app.ts`, add this import next to the other worker imports near the top of the file (the `runExecutionSweep` import is at ~line 266, `runRecurringAgreementsSweep` at ~line 220):

```typescript
import { runOverdueInvoiceSweep } from './workers/overdue-invoice-worker';
```

- [ ] **Step 2: Schedule the sweep**

In `packages/api/src/app.ts`, find the recurring-agreements `setInterval(...)` block (it ends with `}, 60_000);` at ~line 2171). Immediately after that closing line, add:

```typescript
  // §6 Time-to-Cash: overdue-invoice sweep. Hourly — invoice due dates
  // have day granularity, so an hourly check surfaces newly-overdue
  // invoices promptly without churn. Same setInterval driver + tenant
  // lister pattern as the recurring-agreements sweep above; in-memory
  // dev returns no tenants so it no-ops locally.
  const overdueInvoiceLogger = createLogger({
    service: 'overdue-invoice-worker',
    environment: process.env.NODE_ENV || 'development',
  });
  setInterval(async () => {
    try {
      await runOverdueInvoiceSweep({
        jobRepo,
        estimateRepo,
        invoiceRepo,
        auditRepo,
        listTenantIds: async () => {
          if (!pool) return [];
          const r = await pool.query('SELECT id FROM tenants');
          return r.rows.map((row: { id: string }) => row.id);
        },
        logger: overdueInvoiceLogger,
      });
    } catch (err) {
      overdueInvoiceLogger.error('Overdue-invoice sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 60 * 60_000);
```

- [ ] **Step 3: Run the production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit code 0. (Confirms `jobRepo`, `estimateRepo`, `invoiceRepo`, `auditRepo` are all in scope at the insertion point — they are: `jobRepo` is hoisted ~line 537, `estimateRepo`/`invoiceRepo` ~lines 685–686, `auditRepo` ~line 709.)

- [ ] **Step 4: Run the full set of new and touched test files**

Run:
```bash
cd packages/api && npm test -- test/jobs/job-money-state.test.ts test/jobs/job-money-state-wiring.test.ts test/routes/job-money-state.route.test.ts test/workers/overdue-invoice-worker.test.ts test/routes/estimates.route.test.ts test/routes/invoices.route.test.ts
```
Expected: PASS — all files.

- [ ] **Step 5: Run the full API test suite to confirm no wider regression**

Run: `cd packages/api && npm test`
Expected: PASS — no regressions. (The new router/domain-function params are optional; every pre-existing caller is unchanged.)

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/app.ts
git commit -m "feat(api): schedule the overdue-invoice sweep"
```

---

## Self-Review

**1. Spec coverage** — §6's corrected gap (per commit `4b6a7111`) is "the job money-state field + its rollup wiring + an overdue-detection worker + the narrow webhook → job-state hook":
- *Job money-state field* — Task 1 adds the `JobMoneyState` type, the `Job.moneyState` field, migration `095_jobs_money_state`, and the Pg mapping. ✅
- *Rollup logic* — Task 2 (`computeJobMoneyState` precedence fn) + Task 3 (`refreshJobMoneyState` / `Safe`). ✅
- *Rollup wiring* — Task 4 threads it through the four domain choke points; Task 5 makes the invoice/estimate routers + `app.ts` + `test-app.ts` supply the deps and adds the estimate `/send` explicit refresh. ✅
- *Webhook → job-state hook* — Task 5 adds `estimateRepo?` to `WebhookRouterDeps` and passes refresh deps into both of the webhook's `recordPayment` calls, so a Stripe-driven payment rolls the job to `paid` and emits `job.money_state_changed`. ✅
- *Overdue detection + event emission* — Task 6 (`runOverdueInvoiceSweep`, emits `invoice.overdue`) + Task 7 (hourly `setInterval` in `app.ts`). ✅
- Spec line: "Every job carries a visible money state (`no estimate / estimate sent / accepted / invoiced / paid / overdue`)" — the `JobMoneyState` union is exactly those six. ✅ "Overdue emits an event for Section 7" — the worker emits `invoice.overdue`. ✅

**2. Placeholder scan** — every code step contains complete, copy-pasteable code; every test step has an exact path, command, and expected RED/GREEN outcome. No "TBD" / "add error handling" / "similar to Task N". The two test-fixture helper sets (`makeEstimate`/`makeInvoice`) are deliberately repeated in full in each test file rather than cross-referenced, since tasks may be executed out of order.

**3. Type consistency** — `JobMoneyState` (Task 1) is the single source of truth, imported by `job-money-state.ts`, `pg-job.ts`. `RefreshJobMoneyStateDeps` (Task 3: `{ jobRepo, estimateRepo, invoiceRepo, auditRepo? }`) is the exact object built by the invoice router (`{ jobRepo, estimateRepo, invoiceRepo, auditRepo }`), the estimate router (`{ jobRepo: moneyStateDeps.jobRepo, estimateRepo, invoiceRepo: moneyStateDeps.invoiceRepo, auditRepo }`), the webhook (`{ jobRepo, estimateRepo, invoiceRepo, auditRepo }`), and the worker. The optional `moneyStateDeps?: RefreshJobMoneyStateDeps` 4th/5th param on `recordPayment` / `issueInvoice` / `transitionInvoiceStatus` / `transitionEstimateStatus` is named and typed identically across all four. `refreshJobMoneyState` / `refreshJobMoneyStateSafe` keep one signature `(tenantId, jobId, actorId, deps, logger?)`. The circular-import note (all `estimate`/`invoice`/`job` imports in `job-money-state.ts` are `import type`) is enforced by Tasks 2 and 3.

**Cross-task evolution (intentional):** Task 4 adds the optional param to four domain functions but supplies no caller — the Task 4 test calls them directly. Task 5 then makes the routers/webhook supply the deps. Each domain function is byte-for-byte backwards-compatible when the param is omitted, so the build and existing tests stay green between Task 4 and Task 5.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-time-to-cash-completion.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
