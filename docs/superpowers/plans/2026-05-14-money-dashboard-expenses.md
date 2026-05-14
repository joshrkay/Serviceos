# Money Dashboard & Expenses (§8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the expense subsystem end-to-end — a tenant-scoped `expenses` table, a `log_expense` proposal type so the voice agent can log expenses by voice, and a `LogExpenseExecutionHandler` that persists an approved expense — plus a money-dashboard summary (this-month revenue / outstanding / overdue / trend vs. last month) and a tax-ready CSV export covering income + expenses.

**Architecture:** A new `expenses` domain module (`Expense` model, `ExpenseRepository`, in-memory + Pg). A new `log_expense` proposal type wired through the four forcing-function maps (`ProposalType` union, `VALID_PROPOSAL_TYPES`, `actionClassForProposalType`, `PROPOSAL_TYPE_SCHEMAS`) plus a Zod contract. A `LogExpenseExecutionHandler` that — like the other voice handlers — degrades to a synthetic-id passthrough when its repo dep is absent and persists a real row + audit event when wired. The money dashboard is a **pure function** `computeMoneyDashboardSummary(...)` (all the money math, exhaustively unit-tested) behind a `MoneyDashboardRepository` interface with an in-memory canned implementation (route-shape tests) and a Pg implementation (one SQL aggregation). The tax export is a pure `buildTaxExportCsv(rows)` string builder. Both new reports hang off the existing `createReportsRouter`, which this plan converts to an options-object signature.

**Tech Stack:** TypeScript, Node, Express. Tests: vitest + supertest. Persistence: PostgreSQL via the `schema.ts` keyed-migration object; in-memory repositories for tests. Web: React + Tailwind, `useApiClient` fetch hook.

---

## Context the executing engineer needs

**This is a net-new feature build (§8 is the largest of the eleven launch sections).** Nothing about expenses exists today. The money primitives it reads from — `Invoice`, `Payment` — are fully built.

**Money rules (CLAUDE.md core patterns — non-negotiable):**
- All money is **integer cents**, never floating point. `amountCents: number` everywhere; validation rejects non-integers and non-positives.
- All entities carry `tenant_id` + RLS. Every new table gets a `tenant_isolation_*` policy.
- All mutations emit audit events.
- All proposals are typed payloads validated by Zod contracts; the AI never writes directly — `log_expense` flows through the approval inbox like every other proposal.

**The dashboard rolls up from invoices + payments + expenses directly — NOT from §6's per-job money-state.** The launch spec says the dashboard rolls up "from job money-states," but the actual numbers it shows (revenue from paid invoices, outstanding, overdue) are tenant-level aggregates of `payments` and `invoices`. §6's `Job.moneyState` is a *per-job* denormalization for the job list; §8's dashboard is a *tenant* aggregate. Computing it directly from `invoices`/`payments`/`expenses` keeps this plan independently testable and removes a hard ordering dependency on the §6 plan (`2026-05-14-time-to-cash-completion.md`). If §6 has already landed, nothing here conflicts with it.

**`createReportsRouter` is touched by two launch plans.** Both this plan (§8) and the Time-Given-Back plan (§9) add a report to `createReportsRouter` in `packages/api/src/routes/reports.ts`. To keep them independent, **this plan converts `createReportsRouter` from a positional signature to an options-object signature.** Today it is `createReportsRouter(revenueBySourceRepo)`. After this plan it is `createReportsRouter({ revenueBySourceRepo, moneyDashboardRepo, expenseRepo })`. If the §9 plan has already converted it to an options object, do **not** re-convert — just add the `moneyDashboardRepo` and `expenseRepo` keys to the existing options type and the two call sites.

**Migration keys.** `packages/api/src/db/schema.ts` exports `const MIGRATIONS = { '...': '...' }`; `getMigrationSQL()` joins `Object.values(MIGRATIONS)` and the whole SQL re-runs on every boot, so every statement must be idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). `getMigrationSQL()` auto-rewrites `CREATE POLICY x ON t` into `DROP POLICY IF EXISTS x ON t; CREATE POLICY x ON t`, so write a plain `CREATE POLICY`. The highest key in the repo today is `094_add_held_appointment_fields`. The §6 plan claims `095_jobs_money_state`. **This plan claims `096_create_expenses`.** If `096` is already taken when you execute, bump to the next free integer — keys must be unique; the value is idempotent regardless of key.

**Key existing code (exact shapes the tasks depend on):**

- `ProposalType` (`packages/api/src/proposals/proposal.ts:24`): a string-literal union. `VALID_PROPOSAL_TYPES` (line 26) is a runtime array of the same members. `actionClassForProposalType(type)` (line 181) is an **exhaustive `switch`** — adding a `ProposalType` member without a `case` is a compile error (this is the D-003 forcing function). `actionClass` values: `'capture' | 'comms' | 'money' | 'irreversible'`.
- `PROPOSAL_TYPE_SCHEMAS` (`packages/api/src/proposals/contracts.ts:170`): `Record<ProposalType, z.ZodSchema>` — also exhaustive; a missing key is a compile error. `validateProposalPayload(type, payload)` (line 200) reads it. Per-type Zod schemas live in `packages/api/src/proposals/contracts/<name>.ts` and are imported into `contracts.ts`.
- `ExecutionHandler` (`packages/api/src/proposals/execution/handlers.ts:38`): `{ proposalType: ProposalType; execute(proposal, context): Promise<ExecutionResult> }`. `ExecutionContext = { tenantId: string; executedBy: string }` (line 27). `ExecutionResult = { success: boolean; resultEntityId?: string; error?: string }` (line 32). Handlers take repo deps via constructor and degrade to a synthetic-id passthrough when a dep is absent (see `CreateCustomerVoiceExecutionHandler` in `execution/create-customer-handler.ts:61` for the canonical pattern, including the optional `auditRepo` and the failure-soft audit emit).
- `createExecutionHandlerRegistry(deps?)` (`handlers.ts:193`): builds a `Map<ProposalType, ExecutionHandler>`. `deps` already includes `auditRepo`. Push the new handler into the `handlers` array.
- `Invoice` (`packages/api/src/invoices/invoice.ts:8`): `status: 'draft' | 'open' | 'partially_paid' | 'paid' | 'void' | 'canceled'`, `amountDueCents: number`, `dueDate?: Date`, `jobId: string`, `totals: DocumentTotals` (has `totalCents`). `InvoiceRepository.findByTenant(tenantId, options?: InvoiceListOptions)` — `InvoiceListOptions` has `status?`, `fromDueDate?`, `toDueDate?` (no issued-at range).
- `Payment` (`packages/api/src/invoices/payment.ts:8`): `status: 'pending' | 'completed' | 'failed' | 'refunded'`, `amountCents: number`, `receivedAt: Date`, `invoiceId: string`. `PaymentRepository` only has `create / findById / findByInvoice / update` — **no `findByTenant`**. This plan adds a `findByTenant` method to `PaymentRepository` (Task 5) so the dashboard can sum payments in a date window.
- `revenue-by-source.ts` (`packages/api/src/reports/revenue-by-source.ts`) is the canonical report module: a `Pg<Name>Repository extends PgBaseRepository` with `constructor(pool: Pool) { super(pool); }` and `this.withTenant(tenantId, async (client) => {...})`, plus an `InMemory<Name>Repository` with a `setRows()` canned setter. `PgBaseRepository` lives in `packages/api/src/db/pg-base.ts`.
- `createReportsRouter` (`packages/api/src/routes/reports.ts:12`): wired in `app.ts:1909-1912` (`revenueBySourceRepo` is `pool ? new PgRevenueBySourceRepository(pool) : new InMemoryRevenueBySourceRepository()`, mounted at `/api/reports`). The route test `packages/api/test/routes/reports.route.test.ts` builds its own express app inline (`buildApp()`).
- `createAuditEvent(input)` and `AuditRepository` (`packages/api/src/audit/audit.ts`). `InMemoryAuditRepository` exists. Audit-event input: `{ tenantId, actorId, actorRole, eventType, entityType, entityId, correlationId?, metadata? }`.
- Migrations file: `packages/api/src/db/schema.ts`. The `tenant_isolation` RLS policy pattern, e.g. on `audit_events`: `ALTER TABLE x ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation_x ON x USING (tenant_id = current_setting('app.current_tenant_id')::UUID);`
- Web: `useApiClient()` (`packages/web/src/lib/apiClient.ts:88`) returns an `ApiFetch` function. `RevenueBySourcePage` (`packages/web/src/components/reports/RevenueBySourcePage.tsx`) is the canonical report page. Routes are registered in `packages/web/src/routes.ts` (the children array around line 167, e.g. `{ path: 'reports/revenue-by-source', Component: RevenueBySourcePage }`).

**Commands:**
- Run one API test file: from `packages/api`, `npm test -- <relative/path/to/test>`
- Full API test suite: from `packages/api`, `npm test`
- API production typecheck (the Railway build — mandatory before any commit): from repo root, `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- Web build check: from `packages/web`, `npx tsc --noEmit`

---

## File Structure

**Created:**
- `packages/api/src/expenses/expense.ts` — `Expense`, `ExpenseCategory`, `EXPENSE_CATEGORIES`, `CreateExpenseInput`, `ExpenseListOptions`, `ExpenseRepository`, `validateCreateExpenseInput`, `createExpense`, `InMemoryExpenseRepository`.
- `packages/api/src/expenses/pg-expense.ts` — `PgExpenseRepository`.
- `packages/api/test/expenses/expense.test.ts` — unit tests for validation, `createExpense`, in-memory repo.
- `packages/api/src/proposals/contracts/log-expense.ts` — `logExpensePayloadSchema`.
- `packages/api/src/proposals/execution/log-expense-handler.ts` — `LogExpenseExecutionHandler`.
- `packages/api/test/proposals/log-expense-handler.test.ts` — handler tests.
- `packages/api/src/reports/money-dashboard.ts` — `MoneyDashboardSummary`, `MoneyDashboardInput`, `computeMoneyDashboardSummary` (pure), `MoneyDashboardRepository`, `InMemoryMoneyDashboardRepository`.
- `packages/api/src/reports/pg-money-dashboard.ts` — `PgMoneyDashboardRepository`.
- `packages/api/test/reports/money-dashboard.test.ts` — unit tests for the pure function.
- `packages/api/src/reports/tax-export.ts` — `TaxExportRow`, `buildTaxExportCsv` (pure).
- `packages/api/test/reports/tax-export.test.ts` — unit tests for the CSV builder.
- `packages/api/test/routes/money-reports.route.test.ts` — route-shape tests for the two new endpoints.
- `packages/web/src/components/reports/MoneyDashboardPage.tsx` — the dashboard web page.

**Modified:**
- `packages/api/src/db/schema.ts` — add the `096_create_expenses` migration.
- `packages/api/src/proposals/proposal.ts` — add `log_expense` to the union, `VALID_PROPOSAL_TYPES`, and the `actionClassForProposalType` switch.
- `packages/api/src/proposals/contracts.ts` — import + register `logExpensePayloadSchema` in `PROPOSAL_TYPE_SCHEMAS`.
- `packages/api/src/proposals/execution/handlers.ts` — add `expenseRepo` to the deps type and push `LogExpenseExecutionHandler`.
- `packages/api/src/invoices/payment.ts` — add `findByTenant` to `PaymentRepository` + `InMemoryPaymentRepository`.
- `packages/api/src/invoices/pg-payment.ts` — implement `findByTenant` on `PgPaymentRepository`.
- `packages/api/src/routes/reports.ts` — convert `createReportsRouter` to an options object; add `GET /money-dashboard` and `GET /tax-export`.
- `packages/api/src/app.ts` — construct `expenseRepo`, `moneyDashboardRepo`; pass into `createExecutionHandlerRegistry` and `createReportsRouter`.
- `packages/api/test/routes/reports.route.test.ts` — update `buildApp()` for the options-object signature.
- `packages/web/src/routes.ts` — register the `reports/money` route.

---

## Task 1: `Expense` model, migration, and in-memory repository

**Files:**
- Create: `packages/api/src/expenses/expense.ts`
- Modify: `packages/api/src/db/schema.ts`
- Test: `packages/api/test/expenses/expense.test.ts`

- [ ] **Step 1: Create the working branch**

```bash
git checkout main && git checkout -b feat/money-dashboard-expenses
```

- [ ] **Step 2: Write the failing test**

Create `packages/api/test/expenses/expense.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  validateCreateExpenseInput,
  createExpense,
  InMemoryExpenseRepository,
  EXPENSE_CATEGORIES,
} from '../../src/expenses/expense';

const baseInput = {
  tenantId: 't1',
  description: 'Copper fittings at supply house',
  amountCents: 24000,
  category: 'materials' as const,
  spentAt: new Date('2026-05-10T00:00:00.000Z'),
  createdBy: 'u1',
};

describe('validateCreateExpenseInput', () => {
  it('accepts a well-formed input', () => {
    expect(validateCreateExpenseInput(baseInput)).toEqual([]);
  });

  it('rejects a non-integer amount', () => {
    expect(validateCreateExpenseInput({ ...baseInput, amountCents: 240.5 })).toContain(
      'amountCents must be an integer',
    );
  });

  it('rejects a non-positive amount', () => {
    expect(validateCreateExpenseInput({ ...baseInput, amountCents: 0 })).toContain(
      'amountCents must be a positive number of cents',
    );
  });

  it('rejects an unknown category', () => {
    expect(
      validateCreateExpenseInput({ ...baseInput, category: 'snacks' as never }),
    ).toContain('category must be one of: ' + EXPENSE_CATEGORIES.join(', '));
  });

  it('rejects a blank description', () => {
    expect(validateCreateExpenseInput({ ...baseInput, description: '   ' })).toContain(
      'description is required',
    );
  });
});

describe('createExpense', () => {
  it('persists a row with generated id + timestamps', async () => {
    const repo = new InMemoryExpenseRepository();
    const expense = await createExpense({ ...baseInput, jobId: 'job1' }, repo);
    expect(expense.id).toMatch(/[0-9a-f-]{36}/);
    expect(expense.tenantId).toBe('t1');
    expect(expense.jobId).toBe('job1');
    expect(expense.amountCents).toBe(24000);
    expect(expense.createdAt).toBeInstanceOf(Date);
    const found = await repo.findById('t1', expense.id);
    expect(found?.description).toBe('Copper fittings at supply house');
  });

  it('throws on invalid input', async () => {
    const repo = new InMemoryExpenseRepository();
    await expect(createExpense({ ...baseInput, amountCents: -1 }, repo)).rejects.toThrow(
      /Validation failed/,
    );
  });
});

describe('InMemoryExpenseRepository.findByTenant', () => {
  it('filters by tenant, jobId, category and spentAt window', async () => {
    const repo = new InMemoryExpenseRepository();
    await createExpense({ ...baseInput, jobId: 'jobA', spentAt: new Date('2026-05-02') }, repo);
    await createExpense({ ...baseInput, category: 'fuel', spentAt: new Date('2026-05-20') }, repo);
    await createExpense({ ...baseInput, tenantId: 't2', spentAt: new Date('2026-05-10') }, repo);

    expect(await repo.findByTenant('t1')).toHaveLength(2);
    expect(await repo.findByTenant('t1', { jobId: 'jobA' })).toHaveLength(1);
    expect(await repo.findByTenant('t1', { category: 'fuel' })).toHaveLength(1);
    expect(
      await repo.findByTenant('t1', {
        from: new Date('2026-05-01'),
        to: new Date('2026-05-15'),
      }),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/expenses/expense.test.ts`
Expected: FAIL — `Cannot find module '../../src/expenses/expense'`.

- [ ] **Step 4: Create the expense module**

Create `packages/api/src/expenses/expense.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';

/**
 * Expense categories for lightweight bookkeeping (§8). Deliberately a
 * small, trade-relevant fixed set — this is tax-prep visibility, not a
 * full chart of accounts.
 */
export type ExpenseCategory =
  | 'materials'
  | 'fuel'
  | 'tools'
  | 'subcontractor'
  | 'vehicle'
  | 'insurance'
  | 'office'
  | 'other';

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'materials',
  'fuel',
  'tools',
  'subcontractor',
  'vehicle',
  'insurance',
  'office',
  'other',
];

export interface Expense {
  id: string;
  tenantId: string;
  /** Optional link to the job this expense was incurred for. */
  jobId?: string;
  description: string;
  /** Integer cents, always positive. */
  amountCents: number;
  category: ExpenseCategory;
  /** Free-text vendor / supply-house name. */
  vendor?: string;
  /** The date the money was spent (used for tax-period bucketing). */
  spentAt: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateExpenseInput {
  tenantId: string;
  jobId?: string;
  description: string;
  amountCents: number;
  category: ExpenseCategory;
  vendor?: string;
  spentAt: Date;
  createdBy: string;
}

export interface ExpenseListOptions {
  jobId?: string;
  category?: ExpenseCategory;
  /** Inclusive lower bound on `spentAt`. */
  from?: Date;
  /** Exclusive upper bound on `spentAt`. */
  to?: Date;
}

export interface ExpenseRepository {
  create(expense: Expense): Promise<Expense>;
  findById(tenantId: string, id: string): Promise<Expense | null>;
  findByTenant(tenantId: string, options?: ExpenseListOptions): Promise<Expense[]>;
}

export function validateCreateExpenseInput(input: CreateExpenseInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (!input.description || input.description.trim().length === 0) {
    errors.push('description is required');
  }
  if (typeof input.amountCents !== 'number' || input.amountCents <= 0) {
    errors.push('amountCents must be a positive number of cents');
  } else if (!Number.isInteger(input.amountCents)) {
    errors.push('amountCents must be an integer');
  }
  if (!EXPENSE_CATEGORIES.includes(input.category)) {
    errors.push('category must be one of: ' + EXPENSE_CATEGORIES.join(', '));
  }
  if (!(input.spentAt instanceof Date) || Number.isNaN(input.spentAt.getTime())) {
    errors.push('spentAt must be a valid date');
  }
  return errors;
}

export async function createExpense(
  input: CreateExpenseInput,
  repo: ExpenseRepository,
): Promise<Expense> {
  const errors = validateCreateExpenseInput(input);
  if (errors.length > 0) {
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
  }
  const now = new Date();
  const expense: Expense = {
    id: uuidv4(),
    tenantId: input.tenantId,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    description: input.description.trim(),
    amountCents: input.amountCents,
    category: input.category,
    ...(input.vendor ? { vendor: input.vendor } : {}),
    spentAt: input.spentAt,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  return repo.create(expense);
}

export class InMemoryExpenseRepository implements ExpenseRepository {
  private expenses: Map<string, Expense> = new Map();

  async create(expense: Expense): Promise<Expense> {
    this.expenses.set(expense.id, { ...expense });
    return { ...expense };
  }

  async findById(tenantId: string, id: string): Promise<Expense | null> {
    const e = this.expenses.get(id);
    if (!e || e.tenantId !== tenantId) return null;
    return { ...e };
  }

  async findByTenant(tenantId: string, options?: ExpenseListOptions): Promise<Expense[]> {
    return Array.from(this.expenses.values())
      .filter((e) => e.tenantId === tenantId)
      .filter((e) => !options?.jobId || e.jobId === options.jobId)
      .filter((e) => !options?.category || e.category === options.category)
      .filter((e) => !options?.from || e.spentAt.getTime() >= options.from.getTime())
      .filter((e) => !options?.to || e.spentAt.getTime() < options.to.getTime())
      .map((e) => ({ ...e }));
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/expenses/expense.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Add the `096_create_expenses` migration**

In `packages/api/src/db/schema.ts`, add a new entry to the `MIGRATIONS` object immediately after `'094_add_held_appointment_fields'` (or after the highest existing key — bump the integer if `096` is taken):

```typescript
  '096_create_expenses': `
    CREATE TABLE IF NOT EXISTS expenses (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      job_id       UUID REFERENCES jobs(id) ON DELETE SET NULL,
      description  TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      category     TEXT NOT NULL,
      vendor       TEXT,
      spent_at     TIMESTAMPTZ NOT NULL,
      created_by   TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_tenant_spent_at
      ON expenses(tenant_id, spent_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_job
      ON expenses(tenant_id, job_id);
    ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation_expenses ON expenses
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  `,
```

- [ ] **Step 7: Typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/expenses/expense.ts packages/api/test/expenses/expense.test.ts packages/api/src/db/schema.ts
git commit -m "feat(api): add Expense model, in-memory repo, and expenses table"
```

---

## Task 2: `PgExpenseRepository`

**Files:**
- Create: `packages/api/src/expenses/pg-expense.ts`

- [ ] **Step 1: Write the Pg repository**

`PgExpenseRepository` is not unit-tested in isolation (it needs a live Postgres) — this matches the existing codebase pattern (`PgRevenueBySourceRepository` has no unit test; the in-memory repo carries the tested logic). It is verified by the production typecheck and exercised end-to-end by integration runs.

Create `packages/api/src/expenses/pg-expense.ts`:

```typescript
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Expense, ExpenseCategory, ExpenseListOptions, ExpenseRepository } from './expense';

interface ExpenseRow {
  id: string;
  tenant_id: string;
  job_id: string | null;
  description: string;
  amount_cents: string | number;
  category: string;
  vendor: string | null;
  spent_at: Date;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: ExpenseRow): Expense {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.job_id ? { jobId: row.job_id } : {}),
    description: row.description,
    amountCents: Number(row.amount_cents),
    category: row.category as ExpenseCategory,
    ...(row.vendor ? { vendor: row.vendor } : {}),
    spentAt: new Date(row.spent_at),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PgExpenseRepository extends PgBaseRepository implements ExpenseRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(expense: Expense): Promise<Expense> {
    return this.withTenant(expense.tenantId, async (client) => {
      const { rows } = await client.query<ExpenseRow>(
        `INSERT INTO expenses
           (id, tenant_id, job_id, description, amount_cents, category, vendor,
            spent_at, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          expense.id,
          expense.tenantId,
          expense.jobId ?? null,
          expense.description,
          expense.amountCents,
          expense.category,
          expense.vendor ?? null,
          expense.spentAt,
          expense.createdBy,
          expense.createdAt,
          expense.updatedAt,
        ],
      );
      return mapRow(rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Expense | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<ExpenseRow>(
        `SELECT * FROM expenses WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }

  async findByTenant(tenantId: string, options?: ExpenseListOptions): Promise<Expense[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (options?.jobId) {
        params.push(options.jobId);
        conditions.push(`job_id = $${params.length}`);
      }
      if (options?.category) {
        params.push(options.category);
        conditions.push(`category = $${params.length}`);
      }
      if (options?.from) {
        params.push(options.from);
        conditions.push(`spent_at >= $${params.length}`);
      }
      if (options?.to) {
        params.push(options.to);
        conditions.push(`spent_at < $${params.length}`);
      }
      const { rows } = await client.query<ExpenseRow>(
        `SELECT * FROM expenses WHERE ${conditions.join(' AND ')} ORDER BY spent_at DESC`,
        params,
      );
      return rows.map(mapRow);
    });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/expenses/pg-expense.ts
git commit -m "feat(api): add PgExpenseRepository"
```

---

## Task 3: The `log_expense` proposal type + Zod contract

**Files:**
- Modify: `packages/api/src/proposals/proposal.ts`
- Create: `packages/api/src/proposals/contracts/log-expense.ts`
- Modify: `packages/api/src/proposals/contracts.ts`
- Test: `packages/api/test/proposals/log-expense-handler.test.ts` (created here, expanded in Task 4)

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/proposals/log-expense-handler.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  VALID_PROPOSAL_TYPES,
  actionClassForProposalType,
} from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';

describe('log_expense proposal type', () => {
  it('is a valid proposal type classified as capture', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('log_expense');
    expect(actionClassForProposalType('log_expense')).toBe('capture');
  });

  it('accepts a well-formed payload', () => {
    const result = validateProposalPayload('log_expense', {
      description: '$240 at the supply house',
      amountCents: 24000,
      category: 'materials',
      spentAt: '2026-05-10',
      jobId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload with a fractional amount', () => {
    const result = validateProposalPayload('log_expense', {
      description: 'fuel',
      amountCents: 12.5,
      category: 'fuel',
      spentAt: '2026-05-10',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a payload with an unknown category', () => {
    const result = validateProposalPayload('log_expense', {
      description: 'mystery',
      amountCents: 100,
      category: 'snacks',
      spentAt: '2026-05-10',
    });
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/proposals/log-expense-handler.test.ts`
Expected: FAIL — `VALID_PROPOSAL_TYPES` does not contain `'log_expense'` / `validateProposalPayload` returns `Unknown proposal type`.

- [ ] **Step 3: Add `log_expense` to the `ProposalType` union and `VALID_PROPOSAL_TYPES`**

In `packages/api/src/proposals/proposal.ts`, line 24, append `| 'log_expense'` to the `ProposalType` union (place it after `'record_payment'`):

```typescript
export type ProposalType = 'create_customer' | 'update_customer' | 'create_job' | 'create_appointment' | 'create_booking' | 'draft_estimate' | 'update_estimate' | 'draft_invoice' | 'update_invoice' | 'issue_invoice' | 'reassign_appointment' | 'reschedule_appointment' | 'cancel_appointment' | 'voice_clarification' | 'add_note' | 'send_invoice' | 'record_payment' | 'log_expense' | 'emergency_dispatch' | 'onboarding_tenant_settings' | 'onboarding_service_category' | 'onboarding_estimate_template' | 'onboarding_team_member' | 'onboarding_schedule';
```

And add `'log_expense',` to the `VALID_PROPOSAL_TYPES` array (line 26), after `'record_payment',`:

```typescript
  'record_payment',
  'log_expense',
  'emergency_dispatch',
```

- [ ] **Step 4: Classify `log_expense` in `actionClassForProposalType`**

The `actionClassForProposalType` switch (`proposal.ts:181`) is exhaustive — the build will not compile until `log_expense` has a `case`. Logging an expense is a capture/record action (it records something that already happened in the real world; it moves no money and is reversible). Add the `case` to the existing `'capture'` group, after the `onboarding_*` cases:

```typescript
    case 'onboarding_schedule':
    case 'log_expense':
      return 'capture';
```

- [ ] **Step 5: Create the Zod contract**

Create `packages/api/src/proposals/contracts/log-expense.ts`:

```typescript
import { z } from 'zod';
import { EXPENSE_CATEGORIES } from '../../expenses/expense';

/**
 * log_expense proposal payload (§8).
 *
 * Captures a business expense the owner logged by voice ("$240 at the
 * supply house for the Johnson job"). Capture-class — it records a
 * real-world event, moves no money, and is reversible. Amount is
 * integer cents (CLAUDE.md core patterns).
 *
 * `spentAt` is an ISO date string ('YYYY-MM-DD' or a full ISO
 * timestamp); the execution handler parses it to a Date.
 */
export const logExpensePayloadSchema = z.object({
  description: z.string().min(1),
  amountCents: z.number().int().positive(),
  category: z.enum(EXPENSE_CATEGORIES as [string, ...string[]]),
  vendor: z.string().optional(),
  spentAt: z.string().min(1),
  jobId: z.string().uuid().optional(),
});

export type LogExpensePayload = z.infer<typeof logExpensePayloadSchema>;
```

- [ ] **Step 6: Register the contract in `PROPOSAL_TYPE_SCHEMAS`**

In `packages/api/src/proposals/contracts.ts`, add the import near the other contract imports (after the `recordPaymentPayloadSchema` import on line 8):

```typescript
import { recordPaymentPayloadSchema } from './contracts/record-payment';
import { logExpensePayloadSchema } from './contracts/log-expense';
```

Then add the entry to `PROPOSAL_TYPE_SCHEMAS` (the `Record<ProposalType, z.ZodSchema>` at line 170) — it is exhaustive, so the build fails until the key exists. Add after `record_payment`:

```typescript
  record_payment: recordPaymentPayloadSchema,
  log_expense: logExpensePayloadSchema,
  emergency_dispatch: z.object({
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/proposals/log-expense-handler.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors (the two exhaustive maps both now have the `log_expense` key).

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/proposals/proposal.ts packages/api/src/proposals/contracts.ts packages/api/src/proposals/contracts/log-expense.ts packages/api/test/proposals/log-expense-handler.test.ts
git commit -m "feat(api): add log_expense proposal type + Zod contract"
```

---

## Task 4: `LogExpenseExecutionHandler`

**Files:**
- Create: `packages/api/src/proposals/execution/log-expense-handler.ts`
- Modify: `packages/api/src/proposals/execution/handlers.ts`
- Test: `packages/api/test/proposals/log-expense-handler.test.ts` (append)

- [ ] **Step 1: Append the failing handler tests**

Add to `packages/api/test/proposals/log-expense-handler.test.ts` (append at the end of the file):

```typescript
import { LogExpenseExecutionHandler } from '../../src/proposals/execution/log-expense-handler';
import { InMemoryExpenseRepository } from '../../src/expenses/expense';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Proposal } from '../../src/proposals/proposal';

function makeProposal(payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'prop-1',
    tenantId: 't1',
    proposalType: 'log_expense',
    status: 'approved',
    payload,
    summary: 'Log expense',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('LogExpenseExecutionHandler', () => {
  const ctx = { tenantId: 't1', executedBy: 'u1' };
  const goodPayload = {
    description: '$240 at the supply house',
    amountCents: 24000,
    category: 'materials',
    spentAt: '2026-05-10',
    jobId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  };

  it('persists an expense row + emits an audit event when wired', async () => {
    const expenseRepo = new InMemoryExpenseRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new LogExpenseExecutionHandler(expenseRepo, auditRepo);

    const result = await handler.execute(makeProposal(goodPayload), ctx);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
    const stored = await expenseRepo.findById('t1', result.resultEntityId!);
    expect(stored?.amountCents).toBe(24000);
    expect(stored?.category).toBe('materials');
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('expense.logged');
    expect(events[0].entityId).toBe(result.resultEntityId);
  });

  it('degrades to a synthetic-id passthrough when no repo is wired', async () => {
    const handler = new LogExpenseExecutionHandler();
    const result = await handler.execute(makeProposal(goodPayload), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toMatch(/[0-9a-f-]{36}/);
  });

  it('fails cleanly on an invalid payload', async () => {
    const handler = new LogExpenseExecutionHandler(new InMemoryExpenseRepository());
    const result = await handler.execute(
      makeProposal({ description: 'x', amountCents: -1, category: 'materials', spentAt: '2026-05-10' }),
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/amountCents/);
  });

  it('fails cleanly on an unparseable spentAt', async () => {
    const handler = new LogExpenseExecutionHandler(new InMemoryExpenseRepository());
    const result = await handler.execute(
      makeProposal({ ...goodPayload, spentAt: 'not-a-date' }),
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/spentAt/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/proposals/log-expense-handler.test.ts`
Expected: FAIL — `Cannot find module '../../src/proposals/execution/log-expense-handler'`.

- [ ] **Step 3: Write the handler**

Create `packages/api/src/proposals/execution/log-expense-handler.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import {
  ExpenseRepository,
  ExpenseCategory,
  EXPENSE_CATEGORIES,
  createExpense,
} from '../../expenses/expense';
import { AuditRepository, createAuditEvent } from '../../audit/audit';

/**
 * Executes an approved `log_expense` proposal: persists an Expense row
 * and emits an `expense.logged` audit event.
 *
 * Follows the established voice-handler pattern — when no
 * `expenseRepo` is wired (in-memory unit tests that don't exercise
 * the mutation path) it degrades to a synthetic-id passthrough. Audit
 * emission is failure-soft: a logging failure never unwinds a
 * successful expense create.
 */
export class LogExpenseExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'log_expense';

  constructor(
    private readonly expenseRepo?: ExpenseRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    const description = typeof payload.description === 'string' ? payload.description : '';
    const amountCents = typeof payload.amountCents === 'number' ? payload.amountCents : NaN;
    const category = payload.category as ExpenseCategory;
    const vendor = typeof payload.vendor === 'string' ? payload.vendor : undefined;
    const jobId = typeof payload.jobId === 'string' ? payload.jobId : undefined;

    if (!EXPENSE_CATEGORIES.includes(category)) {
      return { success: false, error: `Payload category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` };
    }

    const spentAtRaw = typeof payload.spentAt === 'string' ? payload.spentAt : '';
    const spentAt = new Date(spentAtRaw);
    if (Number.isNaN(spentAt.getTime())) {
      return { success: false, error: 'Payload spentAt must be a parseable date string' };
    }

    // Repo not wired (in-memory unit-test path) → synthetic-id passthrough.
    if (!this.expenseRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    let expenseId: string;
    try {
      const expense = await createExpense(
        {
          tenantId: context.tenantId,
          ...(jobId ? { jobId } : {}),
          description,
          amountCents,
          category,
          ...(vendor ? { vendor } : {}),
          spentAt,
          createdBy: context.executedBy,
        },
        this.expenseRepo,
      );
      expenseId = expense.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to log expense: ${msg}` };
    }

    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'voice_agent',
            eventType: 'expense.logged',
            entityType: 'expense',
            entityId: expenseId,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'log_expense',
              amountCents,
              category,
            },
          }),
        );
      } catch {
        // Audit failures must not unwind a successful expense create.
      }
    }

    return { success: true, resultEntityId: expenseId };
  }
}
```

- [ ] **Step 4: Register the handler in `createExecutionHandlerRegistry`**

In `packages/api/src/proposals/execution/handlers.ts`:

Add the imports near the top (after the `RescheduleAppointmentExecutionHandler` / `CancelAppointmentExecutionHandler` imports, around line 9):

```typescript
import { LogExpenseExecutionHandler } from './log-expense-handler';
import { ExpenseRepository } from '../../expenses/expense';
```

Add `expenseRepo?` to the `deps` parameter type of `createExecutionHandlerRegistry` (line 193), after `analyticsRepo`:

```typescript
  analyticsRepo?: DispatchAnalyticsRepository;
  expenseRepo?: ExpenseRepository;
}): Map<ProposalType, ExecutionHandler> {
```

Add the handler to the `handlers` array (after `RecordPaymentExecutionHandler` on line 221):

```typescript
    new RecordPaymentExecutionHandler(deps?.paymentRepo, deps?.invoiceRepo),
    new LogExpenseExecutionHandler(deps?.expenseRepo, deps?.auditRepo),
  ];
```

> Note: `deps.auditRepo` is already part of the registry call in `app.ts` (line 1008). `LogExpenseExecutionHandler` reads it from the same `deps` object — no extra wiring needed for audit. The `deps` type in `handlers.ts` does not currently list `auditRepo`; if the build flags it as unknown, add `auditRepo?: AuditRepository;` to the deps type and `import { AuditRepository } from '../../audit/audit';`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/proposals/log-expense-handler.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Wire `expenseRepo` into `app.ts`**

In `packages/api/src/app.ts`, find the block that constructs repositories (near where `paymentRepo` is built). Add the expense repo construction alongside it:

```typescript
  const expenseRepo = pool
    ? new PgExpenseRepository(pool)
    : new InMemoryExpenseRepository();
```

Add the imports at the top of `app.ts` (near the other repo imports):

```typescript
import { InMemoryExpenseRepository } from './expenses/expense';
import { PgExpenseRepository } from './expenses/pg-expense';
```

Then pass `expenseRepo` into the `createExecutionHandlerRegistry({ ... })` call (line 997-1009), adding the key alongside `auditRepo`:

```typescript
    schedulingNotifier: schedulingConfirmationNotifier,
    auditRepo,
    expenseRepo,
  });
```

- [ ] **Step 7: Typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/proposals/execution/log-expense-handler.ts packages/api/src/proposals/execution/handlers.ts packages/api/src/app.ts packages/api/test/proposals/log-expense-handler.test.ts
git commit -m "feat(api): add LogExpenseExecutionHandler and wire it into the registry"
```

---

## Task 5: `PaymentRepository.findByTenant`

The money dashboard sums completed payments in a date window. `PaymentRepository` has no tenant-wide query today — this task adds one.

**Files:**
- Modify: `packages/api/src/invoices/payment.ts`
- Modify: `packages/api/src/invoices/pg-payment.ts`
- Test: `packages/api/test/invoices/payment-find-by-tenant.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/invoices/payment-find-by-tenant.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';

function makePayment(over: Partial<Payment>): Payment {
  const now = new Date();
  return {
    id: `pay-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    invoiceId: 'inv1',
    amountCents: 10000,
    method: 'card',
    status: 'completed',
    receivedAt: new Date('2026-05-10T00:00:00.000Z'),
    processedBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('InMemoryPaymentRepository.findByTenant', () => {
  it('filters by tenant, status, and receivedAt window', async () => {
    const repo = new InMemoryPaymentRepository();
    await repo.create(makePayment({ receivedAt: new Date('2026-05-05') }));
    await repo.create(makePayment({ status: 'pending', receivedAt: new Date('2026-05-06') }));
    await repo.create(makePayment({ receivedAt: new Date('2026-06-10') }));
    await repo.create(makePayment({ tenantId: 't2', receivedAt: new Date('2026-05-07') }));

    const all = await repo.findByTenant('t1');
    expect(all).toHaveLength(3);

    const completedInMay = await repo.findByTenant('t1', {
      status: 'completed',
      from: new Date('2026-05-01'),
      to: new Date('2026-06-01'),
    });
    expect(completedInMay).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/invoices/payment-find-by-tenant.test.ts`
Expected: FAIL — `repo.findByTenant is not a function`.

- [ ] **Step 3: Extend the `PaymentRepository` interface + in-memory repo**

In `packages/api/src/invoices/payment.ts`, add a `PaymentListOptions` interface just above `PaymentRepository`:

```typescript
export interface PaymentListOptions {
  status?: PaymentStatus;
  /** Inclusive lower bound on `receivedAt`. */
  from?: Date;
  /** Exclusive upper bound on `receivedAt`. */
  to?: Date;
}
```

Add `findByTenant` to the `PaymentRepository` interface:

```typescript
export interface PaymentRepository {
  create(payment: Payment): Promise<Payment>;
  findById(tenantId: string, id: string): Promise<Payment | null>;
  findByInvoice(tenantId: string, invoiceId: string): Promise<Payment[]>;
  findByTenant(tenantId: string, options?: PaymentListOptions): Promise<Payment[]>;
  update(tenantId: string, id: string, updates: Partial<Payment>): Promise<Payment | null>;
}
```

Implement it on `InMemoryPaymentRepository` (add the method alongside `findByInvoice`):

```typescript
  async findByTenant(tenantId: string, options?: PaymentListOptions): Promise<Payment[]> {
    return Array.from(this.payments.values())
      .filter((p) => p.tenantId === tenantId)
      .filter((p) => !options?.status || p.status === options.status)
      .filter((p) => !options?.from || p.receivedAt.getTime() >= options.from.getTime())
      .filter((p) => !options?.to || p.receivedAt.getTime() < options.to.getTime())
      .map((p) => ({ ...p }));
  }
```

> If `InMemoryPaymentRepository` stores payments in an array rather than a `Map`, adapt the iteration accordingly — the filter chain is unchanged.

- [ ] **Step 4: Implement `findByTenant` on `PgPaymentRepository`**

In `packages/api/src/invoices/pg-payment.ts`, add the method (mirror the existing `findByInvoice` shape; the `paid_at` column maps to `receivedAt`):

```typescript
  async findByTenant(
    tenantId: string,
    options?: PaymentListOptions,
  ): Promise<Payment[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (options?.status) {
        params.push(options.status);
        conditions.push(`status = $${params.length}`);
      }
      if (options?.from) {
        params.push(options.from);
        conditions.push(`paid_at >= $${params.length}`);
      }
      if (options?.to) {
        params.push(options.to);
        conditions.push(`paid_at < $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT * FROM payments WHERE ${conditions.join(' AND ')} ORDER BY paid_at DESC`,
        params,
      );
      return rows.map((row) => this.mapRowToPayment(row));
    });
  }
```

Add `PaymentListOptions` to the import from `./payment` at the top of `pg-payment.ts`.

> If the `PgPaymentRepository` row-mapper is named differently than `mapRowToPayment`, use the existing private mapper name (check the file's other methods).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/invoices/payment-find-by-tenant.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

```bash
git add packages/api/src/invoices/payment.ts packages/api/src/invoices/pg-payment.ts packages/api/test/invoices/payment-find-by-tenant.test.ts
git commit -m "feat(api): add PaymentRepository.findByTenant for money-dashboard rollups"
```

---

## Task 6: `computeMoneyDashboardSummary` pure function + in-memory repository

**Files:**
- Create: `packages/api/src/reports/money-dashboard.ts`
- Test: `packages/api/test/reports/money-dashboard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/reports/money-dashboard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  computeMoneyDashboardSummary,
  MoneyDashboardInput,
} from '../../src/reports/money-dashboard';
import type { Invoice } from '../../src/invoices/invoice';
import type { Payment } from '../../src/invoices/payment';
import type { Expense } from '../../src/expenses/expense';

function invoice(over: Partial<Invoice>): Invoice {
  const now = new Date();
  return {
    id: `inv-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    jobId: 'job1',
    invoiceNumber: 'INV-1',
    status: 'open',
    lineItems: [],
    totals: { subtotalCents: 0, taxCents: 0, totalCents: 0, discountCents: 0 } as Invoice['totals'],
    amountPaidCents: 0,
    amountDueCents: 10000,
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function payment(over: Partial<Payment>): Payment {
  const now = new Date();
  return {
    id: `pay-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    invoiceId: 'inv1',
    amountCents: 10000,
    method: 'card',
    status: 'completed',
    receivedAt: new Date('2026-05-10'),
    processedBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function expense(over: Partial<Expense>): Expense {
  const now = new Date();
  return {
    id: `exp-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    description: 'materials',
    amountCents: 5000,
    category: 'materials',
    spentAt: new Date('2026-05-12'),
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const MONTH = '2026-05';
const NOW = new Date('2026-05-20T12:00:00.000Z');

describe('computeMoneyDashboardSummary', () => {
  it('sums revenue from completed payments inside the month window only', () => {
    const input: MoneyDashboardInput = {
      month: MONTH,
      now: NOW,
      invoices: [],
      payments: [
        payment({ amountCents: 30000, receivedAt: new Date('2026-05-03') }),
        payment({ amountCents: 20000, receivedAt: new Date('2026-05-18') }),
        payment({ amountCents: 99999, receivedAt: new Date('2026-04-30') }), // prior month
        payment({ amountCents: 11111, status: 'pending', receivedAt: new Date('2026-05-09') }), // not completed
      ],
      expenses: [],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.revenueCents).toBe(50000);
  });

  it('computes prior-month revenue and the trend delta', () => {
    const input: MoneyDashboardInput = {
      month: MONTH,
      now: NOW,
      invoices: [],
      payments: [
        payment({ amountCents: 50000, receivedAt: new Date('2026-05-10') }),
        payment({ amountCents: 40000, receivedAt: new Date('2026-04-10') }),
      ],
      expenses: [],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.revenueCents).toBe(50000);
    expect(summary.priorMonthRevenueCents).toBe(40000);
    expect(summary.revenueTrendCents).toBe(10000);
  });

  it('sums outstanding from open/partially_paid invoices as a current snapshot', () => {
    const input: MoneyDashboardInput = {
      month: MONTH,
      now: NOW,
      invoices: [
        invoice({ status: 'open', amountDueCents: 12000 }),
        invoice({ status: 'partially_paid', amountDueCents: 8000 }),
        invoice({ status: 'paid', amountDueCents: 0 }),
        invoice({ status: 'draft', amountDueCents: 99999 }),
        invoice({ status: 'void', amountDueCents: 99999 }),
      ],
      payments: [],
      expenses: [],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.outstandingCents).toBe(20000);
  });

  it('counts an open invoice past its due date as overdue', () => {
    const input: MoneyDashboardInput = {
      month: MONTH,
      now: NOW,
      invoices: [
        invoice({ status: 'open', amountDueCents: 7000, dueDate: new Date('2026-05-15') }), // overdue
        invoice({ status: 'open', amountDueCents: 3000, dueDate: new Date('2026-05-25') }), // not yet
        invoice({ status: 'open', amountDueCents: 1000 }), // no due date → not overdue
      ],
      payments: [],
      expenses: [],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.outstandingCents).toBe(11000);
    expect(summary.overdueCents).toBe(7000);
  });

  it('sums expenses inside the month window only', () => {
    const input: MoneyDashboardInput = {
      month: MONTH,
      now: NOW,
      invoices: [],
      payments: [],
      expenses: [
        expense({ amountCents: 5000, spentAt: new Date('2026-05-04') }),
        expense({ amountCents: 3000, spentAt: new Date('2026-05-28') }),
        expense({ amountCents: 99999, spentAt: new Date('2026-04-15') }),
      ],
    };
    const summary = computeMoneyDashboardSummary(input);
    expect(summary.expensesCents).toBe(8000);
  });

  it('echoes the resolved month label and window bounds', () => {
    const summary = computeMoneyDashboardSummary({
      month: MONTH,
      now: NOW,
      invoices: [],
      payments: [],
      expenses: [],
    });
    expect(summary.month).toBe('2026-05');
    expect(summary.revenueCents).toBe(0);
    expect(summary.expensesCents).toBe(0);
    expect(summary.outstandingCents).toBe(0);
    expect(summary.overdueCents).toBe(0);
  });

  it('throws on a malformed month string', () => {
    expect(() =>
      computeMoneyDashboardSummary({
        month: 'May 2026',
        now: NOW,
        invoices: [],
        payments: [],
        expenses: [],
      }),
    ).toThrow(/month must be/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/reports/money-dashboard.test.ts`
Expected: FAIL — `Cannot find module '../../src/reports/money-dashboard'`.

- [ ] **Step 3: Write the pure function + repository**

Create `packages/api/src/reports/money-dashboard.ts`:

```typescript
import type { Invoice } from '../invoices/invoice';
import type { Payment } from '../invoices/payment';
import type { Expense } from '../expenses/expense';

/**
 * Money dashboard (§8) — a tenant-level rollup the owner sees at a
 * glance. Revenue, expenses, and the prior-month comparison are
 * scoped to the requested calendar month. Outstanding and overdue are
 * *current snapshots* (what is owed right now), independent of the
 * month window — that is how an owner reads them.
 *
 * `computeMoneyDashboardSummary` is pure: it takes already-fetched
 * arrays and `now`, and returns the summary. Repositories fetch the
 * arrays; this function owns the math.
 */
export interface MoneyDashboardSummary {
  /** Resolved 'YYYY-MM' label for the window. */
  month: string;
  /** Completed payments received within the month — integer cents. */
  revenueCents: number;
  /** Completed payments received in the prior calendar month. */
  priorMonthRevenueCents: number;
  /** revenueCents - priorMonthRevenueCents (can be negative). */
  revenueTrendCents: number;
  /** Expenses spent within the month — integer cents. */
  expensesCents: number;
  /** Sum of amountDue on open/partially_paid invoices — current snapshot. */
  outstandingCents: number;
  /** Subset of outstanding whose dueDate is before `now`. */
  overdueCents: number;
}

export interface MoneyDashboardInput {
  /** 'YYYY-MM'. */
  month: string;
  now: Date;
  invoices: Invoice[];
  payments: Payment[];
  expenses: Expense[];
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

interface MonthWindow {
  start: Date;
  end: Date;
  priorStart: Date;
  priorEnd: Date;
}

/** Parse 'YYYY-MM' into UTC [start, end) bounds plus the prior month. */
export function resolveMonthWindow(month: string): MonthWindow {
  const match = MONTH_RE.exec(month);
  if (!match) {
    throw new Error("month must be a 'YYYY-MM' string");
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new Error("month must be a 'YYYY-MM' string with month 01-12");
  }
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  const priorStart = new Date(Date.UTC(year, monthIndex - 1, 1));
  const priorEnd = start;
  return { start, end, priorStart, priorEnd };
}

function inWindow(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t < end.getTime();
}

export function computeMoneyDashboardSummary(
  input: MoneyDashboardInput,
): MoneyDashboardSummary {
  const { start, end, priorStart, priorEnd } = resolveMonthWindow(input.month);

  const completed = input.payments.filter((p) => p.status === 'completed');
  const revenueCents = completed
    .filter((p) => inWindow(p.receivedAt, start, end))
    .reduce((sum, p) => sum + p.amountCents, 0);
  const priorMonthRevenueCents = completed
    .filter((p) => inWindow(p.receivedAt, priorStart, priorEnd))
    .reduce((sum, p) => sum + p.amountCents, 0);

  const expensesCents = input.expenses
    .filter((e) => inWindow(e.spentAt, start, end))
    .reduce((sum, e) => sum + e.amountCents, 0);

  const owing = input.invoices.filter(
    (i) => i.status === 'open' || i.status === 'partially_paid',
  );
  const outstandingCents = owing.reduce((sum, i) => sum + i.amountDueCents, 0);
  const overdueCents = owing
    .filter((i) => i.dueDate !== undefined && i.dueDate.getTime() < input.now.getTime())
    .reduce((sum, i) => sum + i.amountDueCents, 0);

  return {
    month: input.month,
    revenueCents,
    priorMonthRevenueCents,
    revenueTrendCents: revenueCents - priorMonthRevenueCents,
    expensesCents,
    outstandingCents,
    overdueCents,
  };
}

/**
 * Repository seam for the dashboard route. The in-memory variant is a
 * canned-summary stub for route-shape tests (mirrors
 * `InMemoryRevenueBySourceRepository`); the Pg variant (pg-money-dashboard.ts)
 * does the real aggregation. The tested math lives in
 * `computeMoneyDashboardSummary` above.
 */
export interface MoneyDashboardRepository {
  query(tenantId: string, month: string, now: Date): Promise<MoneyDashboardSummary>;
}

export class InMemoryMoneyDashboardRepository implements MoneyDashboardRepository {
  private summary: MoneyDashboardSummary | null = null;

  /** Canned summary for route-shape tests. */
  setSummary(summary: MoneyDashboardSummary): void {
    this.summary = summary;
  }

  async query(_tenantId: string, month: string, _now: Date): Promise<MoneyDashboardSummary> {
    if (this.summary) return this.summary;
    return {
      month,
      revenueCents: 0,
      priorMonthRevenueCents: 0,
      revenueTrendCents: 0,
      expensesCents: 0,
      outstandingCents: 0,
      overdueCents: 0,
    };
  }
}
```

> If `Invoice['totals']` does not have the exact `subtotalCents/taxCents/totalCents/discountCents` shape used in the test helper, open `packages/api/src/invoices/invoice.ts`, read the `DocumentTotals` type, and adjust the `invoice()` test helper's `totals` literal to match. The summary function never reads `totals`, so only the test helper needs to compile.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/reports/money-dashboard.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

```bash
git add packages/api/src/reports/money-dashboard.ts packages/api/test/reports/money-dashboard.test.ts
git commit -m "feat(api): add computeMoneyDashboardSummary pure function + repository seam"
```

---

## Task 7: `PgMoneyDashboardRepository`

**Files:**
- Create: `packages/api/src/reports/pg-money-dashboard.ts`

- [ ] **Step 1: Write the Pg repository**

Not unit-tested in isolation (needs a live Postgres) — matches the `PgRevenueBySourceRepository` precedent. It fetches the three row-sets through the existing tenant-scoped repositories and reuses `computeMoneyDashboardSummary` so the Pg path and the tested path share one implementation of the math.

Create `packages/api/src/reports/pg-money-dashboard.ts`:

```typescript
import { InvoiceRepository } from '../invoices/invoice';
import { PaymentRepository } from '../invoices/payment';
import { ExpenseRepository } from '../expenses/expense';
import {
  MoneyDashboardRepository,
  MoneyDashboardSummary,
  computeMoneyDashboardSummary,
  resolveMonthWindow,
} from './money-dashboard';

/**
 * Production money-dashboard repository. Rather than hand-roll a
 * separate SQL aggregation (which would be a second, untested
 * implementation of the money math), it pulls the relevant row-sets
 * through the existing tenant-scoped repositories — each already
 * RLS-scoped — and runs the single tested `computeMoneyDashboardSummary`.
 *
 * The fetches are deliberately narrow: payments are pulled for the
 * two-month [priorStart, end) span; invoices are pulled unfiltered
 * (the dashboard's outstanding/overdue are a current snapshot, and a
 * solo operator's open-invoice set is small); expenses are pulled for
 * the one-month window.
 */
export class PgMoneyDashboardRepository implements MoneyDashboardRepository {
  constructor(
    private readonly invoiceRepo: InvoiceRepository,
    private readonly paymentRepo: PaymentRepository,
    private readonly expenseRepo: ExpenseRepository,
  ) {}

  async query(tenantId: string, month: string, now: Date): Promise<MoneyDashboardSummary> {
    const { start, end, priorStart } = resolveMonthWindow(month);
    const [invoices, payments, expenses] = await Promise.all([
      this.invoiceRepo.findByTenant(tenantId),
      this.paymentRepo.findByTenant(tenantId, {
        status: 'completed',
        from: priorStart,
        to: end,
      }),
      this.expenseRepo.findByTenant(tenantId, { from: start, to: end }),
    ]);
    return computeMoneyDashboardSummary({ month, now, invoices, payments, expenses });
  }
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

```bash
git add packages/api/src/reports/pg-money-dashboard.ts
git commit -m "feat(api): add PgMoneyDashboardRepository"
```

---

## Task 8: `buildTaxExportCsv` pure function

**Files:**
- Create: `packages/api/src/reports/tax-export.ts`
- Test: `packages/api/test/reports/tax-export.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/api/test/reports/tax-export.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildTaxExportCsv, TaxExportRow } from '../../src/reports/tax-export';

const rows: TaxExportRow[] = [
  {
    date: '2026-05-03',
    type: 'income',
    category: 'invoice',
    description: 'INV-1001',
    jobId: 'job-aaa',
    amountCents: 250000,
  },
  {
    date: '2026-05-10',
    type: 'expense',
    category: 'materials',
    description: 'Copper, "Big Box" supply',
    jobId: 'job-bbb',
    amountCents: 24000,
  },
  {
    date: '2026-05-12',
    type: 'expense',
    category: 'fuel',
    description: 'Diesel',
    amountCents: 8000,
  },
];

describe('buildTaxExportCsv', () => {
  it('emits a header row followed by one row per entry', () => {
    const csv = buildTaxExportCsv(rows);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Date,Type,Category,Description,Job ID,Amount');
    expect(lines).toHaveLength(4);
  });

  it('formats cents as a decimal dollar amount', () => {
    const csv = buildTaxExportCsv(rows);
    expect(csv).toContain('2026-05-03,income,invoice,INV-1001,job-aaa,2500.00');
    expect(csv).toContain('2026-05-12,expense,fuel,Diesel,,80.00');
  });

  it('quotes and escapes fields containing commas or quotes', () => {
    const csv = buildTaxExportCsv(rows);
    expect(csv).toContain('"Copper, ""Big Box"" supply"');
  });

  it('returns just the header for an empty row set', () => {
    expect(buildTaxExportCsv([])).toBe('Date,Type,Category,Description,Job ID,Amount');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/reports/tax-export.test.ts`
Expected: FAIL — `Cannot find module '../../src/reports/tax-export'`.

- [ ] **Step 3: Write the CSV builder**

Create `packages/api/src/reports/tax-export.ts`:

```typescript
/**
 * Tax-ready export (§8) — the date-range packet the owner hands their
 * accountant: income (from paid invoices) + expenses (by category and
 * job). A hand-rolled CSV builder — no new dependency, RFC-4180
 * quoting. PDF is explicitly deferred post-launch (the spec's "CSV/PDF"
 * minimum credible version is satisfied by CSV).
 */
export interface TaxExportRow {
  /** 'YYYY-MM-DD'. */
  date: string;
  type: 'income' | 'expense';
  category: string;
  description: string;
  /** Optional job linkage. */
  jobId?: string;
  /** Integer cents. */
  amountCents: number;
}

const HEADER = 'Date,Type,Category,Description,Job ID,Amount';

/** RFC-4180 field quoting: wrap in quotes + double internal quotes when needed. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function buildTaxExportCsv(rows: TaxExportRow[]): string {
  const lines = [HEADER];
  for (const row of rows) {
    lines.push(
      [
        csvField(row.date),
        csvField(row.type),
        csvField(row.category),
        csvField(row.description),
        csvField(row.jobId ?? ''),
        formatCents(row.amountCents),
      ].join(','),
    );
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/reports/tax-export.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/reports/tax-export.ts packages/api/test/reports/tax-export.test.ts
git commit -m "feat(api): add buildTaxExportCsv tax-export builder"
```

---

## Task 9: Reports router — money-dashboard + tax-export endpoints

**Files:**
- Modify: `packages/api/src/routes/reports.ts`
- Modify: `packages/api/src/app.ts`
- Modify: `packages/api/test/routes/reports.route.test.ts`
- Test: `packages/api/test/routes/money-reports.route.test.ts` (create)

- [ ] **Step 1: Write the failing route-shape test**

Create `packages/api/test/routes/money-reports.route.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createReportsRouter } from '../../src/routes/reports';
import { InMemoryRevenueBySourceRepository } from '../../src/reports/revenue-by-source';
import { InMemoryMoneyDashboardRepository } from '../../src/reports/money-dashboard';
import { InMemoryExpenseRepository, createExpense } from '../../src/expenses/expense';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';

function buildApp() {
  const revenueBySourceRepo = new InMemoryRevenueBySourceRepository();
  const moneyDashboardRepo = new InMemoryMoneyDashboardRepository();
  const expenseRepo = new InMemoryExpenseRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-r1',
      sessionId: 'session-r1',
      tenantId: 'tenant-r1',
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/reports',
    createReportsRouter({ revenueBySourceRepo, moneyDashboardRepo, expenseRepo, invoiceRepo }),
  );
  return { app, moneyDashboardRepo, expenseRepo };
}

describe('GET /api/reports/money-dashboard', () => {
  it('returns the summary under data for a valid month', async () => {
    const { app, moneyDashboardRepo } = buildApp();
    moneyDashboardRepo.setSummary({
      month: '2026-05',
      revenueCents: 500000,
      priorMonthRevenueCents: 400000,
      revenueTrendCents: 100000,
      expensesCents: 80000,
      outstandingCents: 120000,
      overdueCents: 30000,
    });
    const res = await request(app).get('/api/reports/money-dashboard?month=2026-05');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ month: '2026-05', revenueCents: 500000 });
  });

  it('rejects a malformed month with 400', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/reports/money-dashboard?month=May-2026');
    expect(res.status).toBe(400);
  });

  it('defaults to the current month when month is omitted', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/reports/money-dashboard');
    expect(res.status).toBe(200);
    expect(res.body.data.month).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('GET /api/reports/tax-export', () => {
  it('streams CSV with income + expense rows for the window', async () => {
    const { app, expenseRepo } = buildApp();
    await createExpense(
      {
        tenantId: 'tenant-r1',
        description: 'Copper fittings',
        amountCents: 24000,
        category: 'materials',
        spentAt: new Date('2026-05-10'),
        createdBy: 'user-r1',
      },
      expenseRepo,
    );
    const res = await request(app).get(
      '/api/reports/tax-export?from=2026-05-01&to=2026-06-01',
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text.split('\n')[0]).toBe('Date,Type,Category,Description,Job ID,Amount');
    expect(res.text).toContain('expense,materials,Copper fittings');
  });

  it('rejects a missing from/to with 400', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/reports/tax-export?from=2026-05-01');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/routes/money-reports.route.test.ts`
Expected: FAIL — `createReportsRouter` does not accept an options object / the new routes 404.

- [ ] **Step 3: Convert `createReportsRouter` to an options object and add the two endpoints**

Replace the body of `packages/api/src/routes/reports.ts` with:

```typescript
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { RevenueBySourceRepository } from '../reports/revenue-by-source';
import { MoneyDashboardRepository } from '../reports/money-dashboard';
import { ExpenseRepository } from '../expenses/expense';
import { InvoiceRepository } from '../invoices/invoice';
import { buildTaxExportCsv, TaxExportRow } from '../reports/tax-export';

/**
 * Tenant-scoped reporting endpoints. Add new reports here rather than
 * spinning up a separate router per metric.
 *
 * The signature is an options object so multiple launch plans can each
 * add a report without colliding on positional params (see §8 / §9
 * plans). All deps are optional; a route 503s if its dep is absent.
 */
export interface ReportsRouterDeps {
  revenueBySourceRepo: RevenueBySourceRepository;
  moneyDashboardRepo?: MoneyDashboardRepository;
  expenseRepo?: ExpenseRepository;
  invoiceRepo?: InvoiceRepository;
}

/** 'YYYY-MM' for the current UTC month. */
function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function createReportsRouter(deps: ReportsRouterDeps): Router {
  const router = Router();

  router.get(
    '/revenue-by-source',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const fromRaw = req.query.from as string | undefined;
        const toRaw = req.query.to as string | undefined;
        const from = fromRaw ? new Date(fromRaw) : undefined;
        const to = toRaw ? new Date(toRaw) : undefined;
        if (fromRaw && Number.isNaN(from!.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid `from` date' });
          return;
        }
        if (toRaw && Number.isNaN(to!.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid `to` date' });
          return;
        }
        const rows = await deps.revenueBySourceRepo.query(req.auth!.tenantId, { from, to });
        res.json({ data: rows });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/money-dashboard',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.moneyDashboardRepo) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Money dashboard unavailable' });
          return;
        }
        const month = (req.query.month as string | undefined) || currentMonth();
        if (!/^\d{4}-\d{2}$/.test(month)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: "`month` must be 'YYYY-MM'" });
          return;
        }
        const summary = await deps.moneyDashboardRepo.query(req.auth!.tenantId, month, new Date());
        res.json({ data: summary });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/tax-export',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.expenseRepo || !deps.invoiceRepo) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Tax export unavailable' });
          return;
        }
        const fromRaw = req.query.from as string | undefined;
        const toRaw = req.query.to as string | undefined;
        if (!fromRaw || !toRaw) {
          res
            .status(400)
            .json({ error: 'VALIDATION_ERROR', message: 'Both `from` and `to` are required' });
          return;
        }
        const from = new Date(fromRaw);
        const to = new Date(toRaw);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid `from`/`to` date' });
          return;
        }

        const tenantId = req.auth!.tenantId;
        const [invoices, expenses] = await Promise.all([
          deps.invoiceRepo.findByTenant(tenantId, { status: 'paid' }),
          deps.expenseRepo.findByTenant(tenantId, { from, to }),
        ]);

        const rows: TaxExportRow[] = [];
        for (const inv of invoices) {
          const issued = inv.issuedAt ?? inv.createdAt;
          if (issued.getTime() < from.getTime() || issued.getTime() >= to.getTime()) continue;
          rows.push({
            date: issued.toISOString().slice(0, 10),
            type: 'income',
            category: 'invoice',
            description: inv.invoiceNumber,
            jobId: inv.jobId,
            amountCents: inv.totals.totalCents,
          });
        }
        for (const exp of expenses) {
          rows.push({
            date: exp.spentAt.toISOString().slice(0, 10),
            type: 'expense',
            category: exp.category,
            description: exp.description,
            ...(exp.jobId ? { jobId: exp.jobId } : {}),
            amountCents: exp.amountCents,
          });
        }
        rows.sort((a, b) => a.date.localeCompare(b.date));

        const csv = buildTaxExportCsv(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="tax-export-${fromRaw}-to-${toRaw}.csv"`,
        );
        res.send(csv);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
```

> If `Invoice` has no `issuedAt` field, the `inv.issuedAt ?? inv.createdAt` fallback still compiles only if `issuedAt` is declared optional. The Context section confirms `Invoice` carries `issuedAt?: Date` — if the live type differs, use `inv.createdAt` directly.

- [ ] **Step 4: Update the existing `reports.route.test.ts` for the new signature**

In `packages/api/test/routes/reports.route.test.ts`, update `buildApp()` — change the router construction from positional to the options object:

```typescript
  app.use('/api/reports', createReportsRouter({ revenueBySourceRepo: repo }));
```

(The variable is named `repo` in that file — keep it; only the call changes.)

- [ ] **Step 5: Update `app.ts` wiring**

In `packages/api/src/app.ts`, find the reports router block (lines ~1909-1912). Replace it with:

```typescript
  const revenueBySourceRepo = pool
    ? new PgRevenueBySourceRepository(pool)
    : new InMemoryRevenueBySourceRepository();
  const moneyDashboardRepo = new PgMoneyDashboardRepository(
    invoiceRepo,
    paymentRepo,
    expenseRepo,
  );
  app.use(
    '/api/reports',
    createReportsRouter({
      revenueBySourceRepo,
      moneyDashboardRepo,
      expenseRepo,
      invoiceRepo,
    }),
  );
```

Add the import near the other reports imports at the top of `app.ts`:

```typescript
import { PgMoneyDashboardRepository } from './reports/pg-money-dashboard';
```

> `PgMoneyDashboardRepository` composes the existing `invoiceRepo` / `paymentRepo` / `expenseRepo` — it works for both the Pg and in-memory boot paths because those repos already abstract storage. No `pool ? ... : ...` branch needed.
>
> If the §9 (Time-Given-Back) plan has already converted `createReportsRouter` to an options object, this `app.use('/api/reports', ...)` call already passes an object — just add the `moneyDashboardRepo`, `expenseRepo`, and `invoiceRepo` keys to the existing object instead of replacing the block.

- [ ] **Step 6: Run both route tests**

Run: `cd packages/api && npm test -- test/routes/money-reports.route.test.ts test/routes/reports.route.test.ts`
Expected: PASS (all cases in both files).

- [ ] **Step 7: Typecheck + commit**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

```bash
git add packages/api/src/routes/reports.ts packages/api/src/app.ts packages/api/test/routes/reports.route.test.ts packages/api/test/routes/money-reports.route.test.ts
git commit -m "feat(api): money-dashboard + tax-export endpoints on the reports router"
```

---

## Task 10: Money dashboard web page

**Files:**
- Create: `packages/web/src/components/reports/MoneyDashboardPage.tsx`
- Modify: `packages/web/src/routes.ts`

- [ ] **Step 1: Write the page component**

This mirrors `RevenueBySourcePage.tsx` (the canonical report page) — `useApiClient`, month state, fetch in `useEffect`, summary cards, and a download button for the CSV export. There is no manual expense-entry form: expenses are voice-logged via the `log_expense` proposal (Tasks 3–4), so the page is read-only plus the export action.

Create `packages/web/src/components/reports/MoneyDashboardPage.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';

interface MoneyDashboardSummary {
  month: string;
  revenueCents: number;
  priorMonthRevenueCents: number;
  revenueTrendCents: number;
  expensesCents: number;
  outstandingCents: number;
  overdueCents: number;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${Math.abs(cents / 100).toLocaleString(undefined, {
    maximumFractionDigits: 0,
  })}`;
}

/** Current UTC month as 'YYYY-MM'. */
function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First and last day of a 'YYYY-MM' month as ISO dates, for the export range. */
function monthRange(month: string): { from: string; to: string } {
  const [year, mon] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 10);
  return { from, to };
}

export function MoneyDashboardPage() {
  const apiFetch = useApiClient();
  const [month, setMonth] = useState(currentMonth());
  const [summary, setSummary] = useState<MoneyDashboardSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiFetch(`/api/reports/money-dashboard?month=${month}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setSummary(body.data as MoneyDashboardSummary);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [month, apiFetch]);

  async function downloadExport() {
    const { from, to } = monthRange(month);
    const res = await apiFetch(`/api/reports/tax-export?from=${from}&to=${to}`);
    if (!res.ok) {
      setError(`Export failed: HTTP ${res.status}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tax-export-${from}-to-${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const trendUp = (summary?.revenueTrendCents ?? 0) >= 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Money</h1>
            <p className="text-sm text-slate-500">
              This month's revenue, what's outstanding, and what's overdue.
            </p>
          </div>
          <div className="flex items-end gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Month</label>
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value || currentMonth())}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={downloadExport}
              className="rounded-lg bg-slate-900 text-white text-sm px-3 py-2 hover:bg-slate-700"
            >
              Export for taxes (CSV)
            </button>
          </div>
        </div>

        {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!isLoading && !error && summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Revenue</p>
              <p className="text-xl font-semibold text-slate-900 mt-1">
                {formatCents(summary.revenueCents)}
              </p>
              <p className={`text-xs mt-1 ${trendUp ? 'text-green-600' : 'text-red-600'}`}>
                {trendUp ? '▲' : '▼'} {formatCents(summary.revenueTrendCents)} vs. last month
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Expenses</p>
              <p className="text-xl font-semibold text-slate-900 mt-1">
                {formatCents(summary.expensesCents)}
              </p>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5">
              <p className="text-xs text-amber-700 uppercase tracking-wide">Outstanding</p>
              <p className="text-xl font-semibold text-amber-900 mt-1">
                {formatCents(summary.outstandingCents)}
              </p>
            </div>
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3.5">
              <p className="text-xs text-red-700 uppercase tracking-wide">Overdue</p>
              <p className="text-xl font-semibold text-red-900 mt-1">
                {formatCents(summary.overdueCents)}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

> If `useApiClient`'s returned function does not resolve to a `Response` (check `packages/web/src/lib/apiClient.ts` — it may return parsed JSON directly), adapt the `.then`/`.blob()` calls to that contract. `RevenueBySourcePage.tsx` is the reference for the exact shape in this codebase — match it.

- [ ] **Step 2: Register the route**

In `packages/web/src/routes.ts`, add the import near the `RevenueBySourcePage` import (line ~32):

```typescript
import { MoneyDashboardPage } from './components/reports/MoneyDashboardPage';
```

Add the route to the children array, next to the `reports/revenue-by-source` entry (line ~167):

```typescript
      { path: 'reports/money', Component: MoneyDashboardPage },
      { path: 'reports/revenue-by-source', Component: RevenueBySourcePage },
```

- [ ] **Step 3: Web typecheck**

Run: `cd packages/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/reports/MoneyDashboardPage.tsx packages/web/src/routes.ts
git commit -m "feat(web): add Money dashboard page with tax-export download"
```

---

## Task 11: Final verification

**Files:** none — verification only.

- [ ] **Step 1: Full API test suite**

Run: `cd packages/api && npm test`
Expected: all tests pass, including the new `expense`, `log-expense-handler`, `payment-find-by-tenant`, `money-dashboard`, `tax-export`, and `money-reports.route` files. If `decisions.test.ts` exists and runs, confirm it stays green — `log_expense` is classified `capture`, which does not auto-approve money, so D-003 is unaffected.

- [ ] **Step 2: API production typecheck**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Web typecheck**

Run: `cd packages/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Confirm the migration is well-formed**

Run: `cd packages/api && node -e "const { getMigrationSQL } = require('./dist/db/schema'); const sql = getMigrationSQL(); if (!sql.includes('CREATE TABLE IF NOT EXISTS expenses')) throw new Error('expenses migration missing'); console.log('expenses migration present');"`

> If `dist/` is not built, instead just visually confirm the `096_create_expenses` key is present in `MIGRATIONS` and every statement uses `IF NOT EXISTS` / a plain `CREATE POLICY`.

- [ ] **Step 5: Review the diff against the spec**

Confirm against §8 of `docs/superpowers/specs/2026-05-14-serviceos-launch-readiness-design.md`:
- ✅ Expense subsystem: `expenses` table, `Expense` model, in-memory + Pg repos, categorization (`ExpenseCategory`), optional job-linking (`jobId`).
- ✅ Voice-logged expenses: `log_expense` proposal type + Zod contract + `LogExpenseExecutionHandler` (D-004 — flows through the approval inbox like every proposal).
- ✅ Money dashboard: this-month revenue, outstanding, overdue, trend vs. last month — `computeMoneyDashboardSummary` + `/api/reports/money-dashboard` + `MoneyDashboardPage`.
- ✅ Tax-ready export: `/api/reports/tax-export` CSV covering income + expenses by category and job.
- ⚠️ Deferred (documented MVP scoping, consistent with "ruthless per-section MVP"): receipt-photo attach on expenses; PDF export (CSV satisfies the "CSV/PDF" minimum); a manual expense-entry web form (expenses are voice-logged per the fork decision).

- [ ] **Step 6: Commit any verification fixes, then finish the branch**

If steps 1–4 surfaced fixes, commit them. Then use the **superpowers:finishing-a-development-branch** skill to decide how to integrate (PR vs. merge).

---

## Self-Review

**Spec coverage:** Every element of §8's minimum credible version and fork decision maps to a task — expense subsystem (Tasks 1–4), money dashboard rollup (Tasks 6–7, 9–10), tax export (Tasks 8–9). The two deferrals (receipt photos, PDF) are explicitly called out as MVP scoping in Task 11 Step 5.

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases". Every code step shows the full file or the exact edit. The few `>` notes are defensive instructions for shape-mismatches the executing engineer might hit (`DocumentTotals`, `useApiClient` return type, `mapRowToPayment` name) — they point at the authoritative source file, not vague guidance.

**Type consistency:** `Expense` / `ExpenseCategory` / `ExpenseRepository` / `ExpenseListOptions` are defined in Task 1 and used identically in Tasks 2, 4, 7, 9. `MoneyDashboardSummary` / `MoneyDashboardInput` / `computeMoneyDashboardSummary` / `MoneyDashboardRepository` are defined in Task 6 and consumed in Tasks 7, 9, 10. `TaxExportRow` / `buildTaxExportCsv` defined in Task 8, consumed in Task 9. `createReportsRouter`'s new `ReportsRouterDeps` object signature is defined in Task 9 and matched by both the new test (Task 9 Step 1) and the updated existing test (Task 9 Step 4) and `app.ts` (Task 9 Step 5). `PaymentListOptions` defined in Task 5, used in Task 7. `log_expense` is added to all four forcing-function maps in Task 3.

**Known cross-plan merge point:** `createReportsRouter` and the `app.use('/api/reports', ...)` call site are also touched by the §9 plan. Both plans convert to / extend the same options-object signature; Task 9 Step 3 and Step 5 each carry a note for the case where §9 landed first.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-14-money-dashboard-expenses.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
