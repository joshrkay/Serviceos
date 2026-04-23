# Production-Readiness Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four production-blocking gaps surfaced by the 2026-04-23 readiness audit so a real contractor can use ServiceOS without losing writes, double-executing proposals, or silently dropping customer communications. Specifically: (1) make voice "create customer / update customer / create job / draft estimate" actually persist; (2) move the two repositories that still default to `InMemory` even in production onto Postgres; (3) wire the existing `IdempotencyGuard` into `ProposalExecutor` so queue redelivery and operator re-approval can't double-fire mutations; (4) stop `NoopInvoiceDeliveryProvider` from silently swallowing "send invoice" in prod.

**Architecture:** No new architectural patterns — every fix uses scaffolding the codebase already has. The four stub handlers each get the same treatment the existing `CreateInvoiceExecutionHandler` already demonstrates: an optional repo dependency, real persistence path when wired, synthetic-id fallback preserved for in-memory tests. The two singleton in-memory repos get parallel `Pg*` implementations following the patterns in `pg-customer.ts` / `pg-appointment.ts`. The `IdempotencyGuard` is already implemented (`proposals/execution/idempotency.ts`) and the `ProposalExecutor` constructor already accepts it (`executor.ts:19-25`) — it just isn't passed in `app.ts`. The Noop delivery provider stays available for tests but throws at boot in prod.

**Tech Stack:** TypeScript strict, Vitest + supertest, `pg` driver via the existing pool helper, Zod validation at handler boundaries. No new dependencies.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/appointments/pg-assignment.ts` | Postgres-backed `AssignmentRepository` mirroring the in-memory shape. |
| `packages/api/src/dispatch/pg-analytics.ts` | Postgres-backed `DispatchAnalyticsRepository` for reschedule/cancel/reassign counters. |
| `packages/api/test/appointments/pg-assignment.test.ts` | Repository contract tests (RLS, tenant scoping, CRUD round-trips). |
| `packages/api/test/dispatch/pg-analytics.test.ts` | Counter persistence + tenant isolation tests. |

> **Migration mechanism:** This codebase does **not** use a `packages/api/migrations/*.sql` directory. The migration runner in `packages/api/src/db/migrate.ts` calls `getMigrationSQL()` which concatenates the `MIGRATIONS` object exported from `packages/api/src/db/schema.ts:25` (each value is a SQL string keyed by `'NNN_name'`). New migrations are added by appending entries to that object. All migration tasks below modify `schema.ts` rather than creating new SQL files.

### Modified files

**Phase 1 — voice execution handlers (persist or fail loudly):**
- `packages/api/src/proposals/execution/handlers.ts` — `CreateCustomerExecutionHandler`, `UpdateCustomerExecutionHandler`, `CreateJobExecutionHandler`, `DraftEstimateExecutionHandler` accept an optional repo dep; persist when wired; preserve synthetic-id fallback for in-memory tests; thread the deps through `createExecutionHandlerRegistry()`.
- `packages/api/src/app.ts` — pass `customerRepo`, `jobRepo`, `estimateRepo` into `createExecutionHandlerRegistry({...})`.
- `packages/api/test/proposals/execution/handlers.test.ts` — add persisting-path coverage for each handler.

**Phase 2 — kill the InMemory-in-prod repos:**
- `packages/api/src/app.ts:237` — `assignmentRepo = pool ? new PgAssignmentRepository(pool) : new InMemoryAssignmentRepository()`.
- `packages/api/src/app.ts:364` — `dispatchAnalyticsRepo = pool ? new PgDispatchAnalyticsRepository(pool) : new InMemoryDispatchAnalyticsRepository()`.

**Phase 3 — wire the idempotency guard:**
- `packages/api/src/app.ts` — instantiate `IdempotencyGuard(proposalRepo)` and pass it as the third arg to `new ProposalExecutor(executionHandlers, proposalRepo, idempotency)`.
- `packages/api/test/proposals/execution/executor.test.ts` — add a "wired guard short-circuits on duplicate" integration test.

**Phase 4 — fail-fast invoice delivery in prod:**
- `packages/api/src/proposals/execution/voice-extended-handlers.ts` — `NoopInvoiceDeliveryProvider` stays in place (still useful for tests); add a new `RequiredInvoiceDeliveryProvider` factory that throws when called.
- `packages/api/src/app.ts:363` — when `NODE_ENV` is `prod` or `staging` and no real delivery provider is configured, throw at boot instead of silently constructing `NoopInvoiceDeliveryProvider`.

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Persist voice creation handlers

The audit found four handlers in `handlers.ts` that validate payload shape and return `{ success: true, resultEntityId: uuidv4() }` without ever calling a repository. A contractor saying "add customer Jane" today gets a green proposal in the timeline that points at a uuid no row will ever match. `CreateInvoiceExecutionHandler` (already done in P5-005) is the template: optional repo via constructor, persisting path when present, synthetic-id fallback when absent so legacy in-memory tests still pass.

### Task 1: Persist `CreateCustomerExecutionHandler`

**Files:**
- Modify: `packages/api/src/proposals/execution/handlers.ts`
- Modify: `packages/api/test/proposals/execution/handlers.test.ts`

**Context:** Today the handler at `handlers.ts:42-52` returns a fresh uuid without writing to `customerRepo`. The downstream proposal carries the fake id forever. Mirror `CreateInvoiceExecutionHandler`'s shape: optional `customerRepo` constructor arg, real `createCustomer` path, synthetic-id fallback preserved.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/proposals/execution/handlers.test.ts (add inside CreateCustomerExecutionHandler describe)
it('persists the customer when a repo is wired and returns the persisted id', async () => {
  const repo = new InMemoryCustomerRepository();
  const handler = new CreateCustomerExecutionHandler(repo);
  const proposal = makeProposal('create_customer', {
    name: 'Jane Doe',
    email: 'jane@example.com',
  });

  const result = await handler.execute(proposal, { tenantId: 't1', executedBy: 'u1' });

  expect(result.success).toBe(true);
  expect(result.resultEntityId).toBeDefined();
  const persisted = await repo.findById('t1', result.resultEntityId!);
  expect(persisted?.name).toBe('Jane Doe');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/proposals/execution/handlers.test.ts -t "persists the customer"`
Expected: FAIL — `repo.findById` returns `null` because the handler never writes.

- [ ] **Step 3: Update the handler**

Note on payload shape: today the `create_customer` proposal payload carries
`payload.name` (a single string from the voice classifier's `displayName`).
`CreateCustomerInput` (`packages/api/src/customers/customer.ts:28-41`) expects
`firstName` + `lastName` (or `companyName`) and `primaryPhone` instead of
`phone`. The handler is responsible for the mapping. The minimal split below
puts the whole transcript-supplied name into `firstName` with empty
`lastName`; this matches the `validateCustomerInput` rule that requires
`firstName || companyName`. A follow-up can introduce real
firstName/lastName splitting in the classifier or the proposal-authoring
step — that's a UX question, not a blocker.

```typescript
// packages/api/src/proposals/execution/handlers.ts
export class CreateCustomerExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_customer';

  constructor(private readonly customerRepo?: CustomerRepository) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    if (!payload.name || typeof payload.name !== 'string') {
      return { success: false, error: 'Payload must include a valid name' };
    }
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }
    if (!this.customerRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }
    try {
      const customer = await createCustomer(
        {
          tenantId: context.tenantId,
          firstName: payload.name,
          lastName: '',
          email: typeof payload.email === 'string' ? payload.email : undefined,
          primaryPhone: typeof payload.phone === 'string' ? payload.phone : undefined,
          createdBy: context.executedBy,
        },
        this.customerRepo
      );
      return { success: true, resultEntityId: customer.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

Add the import at the top: `import { CustomerRepository, createCustomer } from '../../customers/customer';`

- [ ] **Step 4: Thread the dep through the registry**

```typescript
// packages/api/src/proposals/execution/handlers.ts (createExecutionHandlerRegistry)
export function createExecutionHandlerRegistry(deps?: {
  customerRepo?: CustomerRepository;
  // ...existing deps
}): Map<ProposalType, ExecutionHandler> {
  const handlers: ExecutionHandler[] = [
    new CreateCustomerExecutionHandler(deps?.customerRepo),
    // ...
  ];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/proposals/execution/handlers.test.ts`
Expected: PASS (all existing tests + new persistence test).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/proposals/execution/handlers.ts packages/api/test/proposals/execution/handlers.test.ts
git commit -m "fix(proposals): persist CreateCustomerExecutionHandler when repo wired"
```

### Task 2: Persist `UpdateCustomerExecutionHandler`

**Files:**
- Modify: `packages/api/src/proposals/execution/handlers.ts`
- Modify: `packages/api/test/proposals/execution/handlers.test.ts`

**Context:** Same shape as Task 1 — `handlers.ts:54-64` validates `customerId` then returns `{ success: true }` without applying the patch. The function to call is `updateCustomer(tenantId, id, input, repository, actorId?, auditRepo?)` from `packages/api/src/customers/customer.ts:201-208` (note the parameter order — `tenantId` and `id` come first, `input` is third). `UpdateCustomerInput` accepts the same `firstName`/`lastName`/`primaryPhone`/etc. fields documented in Task 1; the same payload-mapping note applies. The handler should pass `context.executedBy` as the `actorId` so audit attribution is correct.

- [ ] **Step 1: Write a failing test that asserts the patched fields appear in the repo when the proposal carries `customerId` plus updated fields.**
- [ ] **Step 2: Run to confirm failure.**
- [ ] **Step 3: Implement constructor-injected `customerRepo`. Call `updateCustomer(context.tenantId, payload.customerId, mappedInput, this.customerRepo, context.executedBy)` when the repo is present; preserve the synthetic-success fallback when absent. Return `{ success: false, error: 'Customer not found' }` when `updateCustomer` returns `null`.**
- [ ] **Step 4: Wire the dep in `createExecutionHandlerRegistry` (already added in Task 1).**
- [ ] **Step 5: Run tests.**
- [ ] **Step 6: Commit:** `fix(proposals): persist UpdateCustomerExecutionHandler when repo wired`

### Task 3: Persist `CreateJobExecutionHandler`

**Files:**
- Modify: `packages/api/src/proposals/execution/handlers.ts`
- Modify: `packages/api/test/proposals/execution/handlers.test.ts`

**Context:** `handlers.ts:66-79` validates `customerId` and `title`, then returns a synthetic uuid. The destination function is `createJob(input, repo)` (`packages/api/src/jobs/job.ts:71-`) and `CreateJobInput` (`jobs/job.ts:24-33`) requires `tenantId`, `customerId`, **`locationId`**, **`summary`**, and `createdBy`. Two field gaps to bridge:

1. **`title` → `summary`** — the existing handler validates `payload.title` but the persistence interface uses `summary`. Map `payload.title` to `summary` (and accept either key in payload validation if older proposals are still in flight; otherwise just rename in the validation step).
2. **`locationId` resolution** — the voice classifier never captures a location. The handler must resolve it from the customer's locations: call `locationRepo.findByCustomer(tenantId, customerId)` and pick the entry where `isPrimary === true` (`packages/api/src/locations/location.ts:17,56`). If the customer has zero locations, return `{ success: false, error: 'Customer has no service location — add one before opening a job' }` rather than fabricating a uuid. This also means `CreateJobExecutionHandler` takes **two** repo deps: `jobRepo` and `locationRepo`.

Optional payload field: if a future proposal explicitly carries `payload.locationId`, prefer it over the resolved primary (lets a dispatcher pre-select a non-primary site).

- [ ] **Step 1: Write a failing test that:**
  - **(a)** Seeds a customer with a primary location in `InMemoryLocationRepository`.
  - **(b)** Submits a `create_job` proposal with `customerId` + `title`.
  - **(c)** Asserts the persisted job has `summary === payload.title`, `customerId` matches, and `locationId === <primary location id>`.
- [ ] **Step 2: Add a second test for the no-locations case asserting `success === false` with a useful error.**
- [ ] **Step 3: Confirm both fail.**
- [ ] **Step 4: Implement the handler with optional `jobRepo` + `locationRepo` constructor args. When either is missing, fall back to the synthetic-id path; when both are wired, do the primary-location lookup then call `createJob`.**
- [ ] **Step 5: Update `createExecutionHandlerRegistry` to accept and forward `jobRepo` + `locationRepo`. Pass both from `app.ts`.**
- [ ] **Step 6: Run tests.**
- [ ] **Step 7: Commit:** `fix(proposals): persist CreateJobExecutionHandler with primary-location resolution`

### Task 4: Persist `DraftEstimateExecutionHandler`

**Files:**
- Modify: `packages/api/src/proposals/execution/handlers.ts`
- Modify: `packages/api/test/proposals/execution/handlers.test.ts`

**Context:** `handlers.ts:177-190` validates `customerId` and `lineItems`, then returns a synthetic uuid. The destination function is `createEstimate` and `CreateEstimateInput` (`packages/api/src/estimates/estimate.ts:24-35`) requires `tenantId`, **`jobId`** (not just `customerId`), **`estimateNumber`**, `lineItems`, and `createdBy`. Two field gaps:

1. **`jobId` is required.** The current `draft_estimate` proposal payload only carries `customerId` + `lineItems`. There is no clean way to draft an estimate without a job (the estimate-number sequence, billing, and acceptance flow all key off the job). The right fix is to **add `jobId` to the payload validation** in this handler and require the proposal-authoring step (voice classifier, dispatcher UI) to attach it. When the payload arrives without `jobId`, return `{ success: false, error: 'Estimate requires a jobId — pick a job before drafting' }`. This is a deliberate hard-fail — auto-creating a phantom job to satisfy the FK would corrupt the contractor's job list.
2. **`estimateNumber` auto-increment.** Use `getNextEstimateNumber(tenantId, settingsRepo)` from `packages/api/src/settings/settings.ts:303` — same dual-dep pattern `CreateInvoiceExecutionHandler` already uses with `getNextInvoiceNumber`.

So `DraftEstimateExecutionHandler` takes optional `estimateRepo` + `settingsRepo` constructor args, just like `CreateInvoiceExecutionHandler`.

- [ ] **Step 1: Write three failing tests:**
  - **(a)** Happy path with `customerId` + `jobId` + `lineItems` → asserts the persisted estimate has the auto-incremented number and the supplied jobId.
  - **(b)** Missing `jobId` → asserts `success === false` with the specific error message.
  - **(c)** Idempotency — second call with the same `proposal.resultEntityId` returns the same id without creating a duplicate.
- [ ] **Step 2: Confirm failures.**
- [ ] **Step 3: Implement optional `estimateRepo` + `settingsRepo` constructor args. Add `jobId` to validation. Call `getNextEstimateNumber` then `createEstimate`. Preserve synthetic-id fallback when either dep is absent.**
- [ ] **Step 4: Update `createExecutionHandlerRegistry` to pass `estimateRepo` and `settingsRepo`.**
- [ ] **Step 5: Run tests.**
- [ ] **Step 6: Commit:** `fix(proposals): persist DraftEstimateExecutionHandler when repos wired`

> **Follow-up (out of scope for this plan, but flagged here):** The classifier and dispatcher proposal-review UI need to enforce `jobId` capture for `draft_estimate`. Until that lands, voice "draft an estimate for…" without an obvious job reference will (correctly) fail at execution. Track as a separate story under voice UX hardening.

### Task 5: Wire all four handler deps in `app.ts`

**Files:**
- Modify: `packages/api/src/app.ts`

**Context:** The four handlers above now accept repos but `app.ts:365-375` only passes a subset. Add `customerRepo`, `jobRepo`, and `locationRepo` to the registry call (estimate is covered once `estimateRepo` and `settingsRepo` are passed — both already exist in scope).

- [ ] **Step 1: Write an integration test in `packages/api/test/integration/voice-create-customer.test.ts` that POSTs an approved `create_customer` proposal through the executor and asserts the customer appears via `GET /api/customers/:id`.**
- [ ] **Step 2: Confirm failure (the customer 404s).**
- [ ] **Step 3: Update the registry call.**

```typescript
// packages/api/src/app.ts
const executionHandlers = createExecutionHandlerRegistry({
  customerRepo,
  jobRepo,
  locationRepo,
  appointmentRepo,
  assignmentRepo,
  invoiceRepo,
  estimateRepo,
  settingsRepo,
  noteRepo,
  paymentRepo,
  invoiceDeliveryProvider,
  analyticsRepo: dispatchAnalyticsRepo,
});
```

- [ ] **Step 4: Run integration test → green.**
- [ ] **Step 5: Run full suite:** `cd packages/api && npx vitest run`
- [ ] **Step 6: Commit:** `fix(app): wire customerRepo/jobRepo into proposal execution registry`

---

## Phase 2: Move singleton InMemory repos to Postgres

Two repositories are still constructed as `InMemory*` regardless of `DATABASE_URL` — `assignmentRepo` (`app.ts:237`) and `dispatchAnalyticsRepo` (`app.ts:364`). Both lose all data on every prod restart. Both already have an interface — they just need a `Pg*` implementation.

### Task 6: Add `assignments` migration to `schema.ts`

**Files:**
- Modify: `packages/api/src/db/schema.ts` (append a new key under `MIGRATIONS`)

**Context:** Mirror the `AppointmentAssignment` interface (`packages/api/src/appointments/assignment.ts:5-13`) exactly. Required columns: `id`, `tenant_id`, `appointment_id`, `technician_id`, `is_primary` (BOOLEAN NOT NULL — promotion/demotion is core to the assignment flow at `assignment.ts:54-57`), `assigned_by`, `assigned_at`. The interface has **no** unassigned timestamps — removal happens via `delete()`. Apply the same tenant-scoped RLS pattern used by every other table in `schema.ts`.

- [ ] **Step 1: Add a new entry to the `MIGRATIONS` object — pick the next available numeric prefix (look at the highest-numbered existing key first):**

```typescript
// packages/api/src/db/schema.ts (inside MIGRATIONS, append at end)
'NNN_create_assignments': `
  CREATE TABLE IF NOT EXISTS assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    appointment_id UUID NOT NULL,
    technician_id UUID NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    assigned_by TEXT NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_assignments_tenant_appt ON assignments(tenant_id, appointment_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_tenant_tech ON assignments(tenant_id, technician_id);
  ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_assignments ON assignments;
  CREATE POLICY tenant_isolation_assignments ON assignments
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,
```

- [ ] **Step 2: Add a unit test in `packages/api/test/db/schema.test.ts` that asserts the new key exists and the SQL parses (follow existing test patterns in that file).**
- [ ] **Step 3: Apply locally via the standard migration runner (whichever script the repo already uses — check `package.json` scripts).**
- [ ] **Step 4: Confirm via `psql` that the table + RLS policy exist.**
- [ ] **Step 5: Commit:** `feat(db): add assignments table with RLS`

### Task 7: Implement `PgAssignmentRepository`

**Files:**
- Create: `packages/api/src/appointments/pg-assignment.ts`
- Create: `packages/api/test/appointments/pg-assignment.test.ts`

**Context:** Follow `pg-appointment.ts` for the SQL helper conventions (parameterized queries, `setLocalTenantContext` before each call so RLS scopes correctly).

- [ ] **Step 1: Write contract tests — every method on `AssignmentRepository` round-trips and respects tenant isolation (insert as tenant A, query as tenant B → empty).**
- [ ] **Step 2: Confirm failures (file doesn't exist).**
- [ ] **Step 3: Implement `PgAssignmentRepository`.**
- [ ] **Step 4: Run tests → green.**
- [ ] **Step 5: Commit:** `feat(appointments): PgAssignmentRepository`

### Task 8: Wire `PgAssignmentRepository` in `app.ts`

**Files:**
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Update `app.ts:237` to `pool ? new PgAssignmentRepository(pool) : new InMemoryAssignmentRepository()`.**
- [ ] **Step 2: Run the full API test suite to confirm no regressions.**
- [ ] **Step 3: Commit:** `fix(app): use PgAssignmentRepository when DATABASE_URL is set`

### Task 9: Add `dispatch_analytics` migration to `schema.ts`

**Files:**
- Modify: `packages/api/src/db/schema.ts` (append a new key under `MIGRATIONS`)

**Context:** Mirror `DispatchMetric` (`packages/api/src/dispatch/analytics.ts:12-20`) exactly. Required columns: `id`, `tenant_id`, `event_type` (constrained to the `DispatchEventType` enum: `assigned`, `reassigned`, `rescheduled`, `canceled`, `conflict_detected`, `delay_notice_sent`, `delay_notice_failed`), `appointment_id` (nullable — interface has it optional), `technician_id` (**nullable but present** — execution handlers emit it for reassignments and per-technician analytics; omitting it would silently drop technician-level data), `metadata` (JSONB, nullable), `recorded_at`. Tenant-scoped RLS.

- [ ] **Step 1: Add the migration entry:**

```typescript
// packages/api/src/db/schema.ts (inside MIGRATIONS, append at end)
'NNN_create_dispatch_analytics': `
  CREATE TABLE IF NOT EXISTS dispatch_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    event_type TEXT NOT NULL CHECK (event_type IN (
      'assigned', 'reassigned', 'rescheduled', 'canceled',
      'conflict_detected', 'delay_notice_sent', 'delay_notice_failed'
    )),
    appointment_id UUID,
    technician_id UUID,
    metadata JSONB,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_dispatch_analytics_tenant_recorded ON dispatch_analytics(tenant_id, recorded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dispatch_analytics_tenant_type ON dispatch_analytics(tenant_id, event_type);
  CREATE INDEX IF NOT EXISTS idx_dispatch_analytics_tenant_tech ON dispatch_analytics(tenant_id, technician_id) WHERE technician_id IS NOT NULL;
  ALTER TABLE dispatch_analytics ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_dispatch_analytics ON dispatch_analytics;
  CREATE POLICY tenant_isolation_dispatch_analytics ON dispatch_analytics
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,
```

- [ ] **Step 2: Add a unit test in `packages/api/test/db/schema.test.ts` asserting the new key exists.**
- [ ] **Step 3: Apply locally and verify via `psql`.**
- [ ] **Step 4: Commit:** `feat(db): add dispatch_analytics table with RLS`

### Task 10: Implement `PgDispatchAnalyticsRepository`

**Files:**
- Create: `packages/api/src/dispatch/pg-analytics.ts`
- Create: `packages/api/test/dispatch/pg-analytics.test.ts`

- [ ] **Step 1: Write contract tests against the existing `DispatchAnalyticsRepository` interface.**
- [ ] **Step 2: Confirm failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.**
- [ ] **Step 5: Commit:** `feat(dispatch): PgDispatchAnalyticsRepository`

### Task 11: Wire `PgDispatchAnalyticsRepository` in `app.ts`

**Files:**
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Update `app.ts:364` to `pool ? new PgDispatchAnalyticsRepository(pool) : new InMemoryDispatchAnalyticsRepository()`.**
- [ ] **Step 2: Run full suite.**
- [ ] **Step 3: Commit:** `fix(app): use PgDispatchAnalyticsRepository when DATABASE_URL is set`

---

## Phase 3: Wire the IdempotencyGuard

`IdempotencyGuard` is already implemented in `proposals/execution/idempotency.ts` and `ProposalExecutor` already accepts it as an optional third constructor arg (`executor.ts:19-25`). It is never passed in `app.ts`. Result: a queue redelivery or operator double-tap on Approve fires the handler twice.

### Task 12: Instantiate and pass `IdempotencyGuard` in `app.ts`

**Files:**
- Modify: `packages/api/src/app.ts`
- Modify: `packages/api/test/proposals/execution/executor.test.ts` (or add a new integration test)

- [ ] **Step 1: Write a failing test — submit the same approved proposal with the same `idempotencyKey` twice through the executor; assert exactly one handler invocation and one `executed` row in the audit log.**
- [ ] **Step 2: Confirm failure (handler runs twice).**
- [ ] **Step 3: Update `app.ts`:**

```typescript
// near where ProposalExecutor is constructed
import { IdempotencyGuard } from './proposals/execution/idempotency';
// ...
const idempotencyGuard = new IdempotencyGuard(proposalRepo);
const proposalExecutor = new ProposalExecutor(executionHandlers, proposalRepo, idempotencyGuard);
```

- [ ] **Step 4: Run test → green.**
- [ ] **Step 5: Run full suite.**
- [ ] **Step 6: Commit:** `fix(proposals): wire IdempotencyGuard into ProposalExecutor`

---

## Phase 4: Fail-fast `NoopInvoiceDeliveryProvider` in production

`app.ts:363` constructs `new NoopInvoiceDeliveryProvider()` unconditionally. In prod that means a contractor saying "send the Smith invoice" gets a green proposal, an audit log entry, and zero bytes leave the building. The Noop provider is genuinely useful for in-memory tests; the bug is using it as the production default.

### Task 13: Make production refuse to boot with a no-op invoice delivery provider

**Files:**
- Modify: `packages/api/src/app.ts`

**Context:** Mirror the DATABASE_URL guard at `app.ts:160-162`. There's no real invoice delivery provider yet (Twilio / SES integration is its own Phase 7 story), so the right behavior today is: throw at boot in prod/staging, allow the noop in dev/test. Once the real provider lands, this guard becomes a constructor-call swap.

- [ ] **Step 1: Write a failing test in `packages/api/test/app/boot-guards.test.ts` that asserts `createApp()` throws when `NODE_ENV === 'prod'` and no `INVOICE_DELIVERY_PROVIDER` env is configured.**
- [ ] **Step 2: Confirm failure (app boots silently).**
- [ ] **Step 3: Add the guard:**

```typescript
// packages/api/src/app.ts (replacing line 363)
const invoiceDeliveryProvider =
  config.NODE_ENV === 'prod' || config.NODE_ENV === 'staging'
    ? (() => {
        throw new Error(
          'No invoice delivery provider configured. Voice "send invoice" would silently drop in production. ' +
          'Either configure a real provider or block the send_invoice intent at the router.'
        );
      })()
    : new NoopInvoiceDeliveryProvider();
```

- [ ] **Step 4: Run test → green.**
- [ ] **Step 5: Run full suite.**
- [ ] **Step 6: Commit:** `fix(app): refuse to boot with noop invoice delivery in prod`

---

## Phase 5: End-to-end verification

### Task 14: Run the production build verification

**Files:** none modified.

**Context:** `CLAUDE.md` mandates this before any push. The production tsconfig excludes test files and vitest types — it catches errors the default `tsconfig.json` hides.

- [ ] **Step 1:** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- [ ] **Step 2:** Fix any reported type errors.
- [ ] **Step 3:** Re-run until clean.

### Task 15: Run the full API + web test suites

- [ ] **Step 1:** `cd packages/api && npx vitest run`
- [ ] **Step 2:** `cd packages/web && npx vitest run`
- [ ] **Step 3:** Both green.

### Task 16: Smoke test the contractor voice path locally

**Context:** Type checks and unit tests verify code correctness, not feature correctness. This is the manual gate before declaring the audit findings closed.

- [ ] **Step 1:** Start the API (`cd packages/api && npm run dev`) and the web client (`cd packages/web && npm run dev`).
- [ ] **Step 2:** Through the dispatcher UI, run the voice transcript "Add a new customer named Audit Test, email audit@example.com" → approve the proposal → confirm the customer appears in `GET /api/customers` AND in the dispatcher customer list.
- [ ] **Step 3:** Repeat for "Create a job for Audit Test — water heater".
- [ ] **Step 4:** Repeat for "Draft an estimate for Audit Test for 450 dollars, water heater diagnostic".
- [ ] **Step 5:** Approve a proposal twice in quick succession (use the API directly with the same idempotency key) → confirm only one execution.
- [ ] **Step 6:** Set `NODE_ENV=prod` and start the API → confirm it refuses to boot citing the missing invoice delivery provider.

---

## Out of scope

Deliberately excluded from this plan because they are larger / Phase 7 / require external integrations:

- **Twilio SMS, on-my-way ETAs, appointment reminders** — separate plan; needs a vendor decision and webhook contract.
- **QuickBooks / Xero sync** — separate plan; OAuth dance + sync queue is multi-story.
- **Voice READ intents** ("what's on my schedule today?") — needs a query router and a results-rendering surface; bigger than a blocker fix.
- **Drag-drop scheduling → proposal wiring on the dispatch board** — UX-heavy; warrants a /design-review pass before code.
- **Customer self-serve portal** (confirm appointment, pay invoice from a link) — payment page exists; reminders + confirmation tokens are their own scope.

Each of these belongs in its own plan once these blockers are closed.
