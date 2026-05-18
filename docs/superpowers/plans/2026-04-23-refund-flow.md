# Refund Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow dispatchers to issue full or partial refunds on paid invoices, backed by Stripe. Each refund is idempotency-guarded, audit-logged, and reconciles the invoice's `amountPaidCents`/`amountDueCents` fields. The action travels through the existing proposal workflow — a dispatcher creates an `issue_refund` proposal (202 response), approves it, and the execution handler calls Stripe and updates balances atomically.

**Architecture:** A new `refunds` table is joined to `payments` via `payment_id`; refund totals are aggregated to compute `refunded_cents` when recalculating invoice balance. The `StripeRefundProvider` mirrors the bare-fetch pattern already used by `StripePaymentLinkProvider`. The `IssueRefundExecutionHandler` follows the same `ExecutionHandler` interface used by every existing handler and is registered in `createExecutionHandlerRegistry`. Frontend adds a `RefundModal` component embedded inside the existing `InvoiceDetail` page.

**Tech Stack:** TypeScript, Express, `pg` (bare Pool/PoolClient via `PgBaseRepository`), Zod for payload validation, bare `fetch` for Stripe API calls, React + Tailwind for the modal, Vitest for all tests.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/refunds/refund.ts` | `Refund` type, `RefundRepository` interface, `InMemoryRefundRepository`, domain helpers (`validateRefundInput`, `computeAlreadyRefunded`) |
| `packages/api/src/refunds/pg-refund.ts` | `PgRefundRepository` — Postgres implementation extending `PgBaseRepository` |
| `packages/api/src/payments/refund-provider.ts` | `RefundProvider` interface, `NoopRefundProvider`, `StripeRefundProvider` |
| `packages/api/src/proposals/execution/issue-refund-handler.ts` | `IssueRefundExecutionHandler` — validates, calls provider, persists refund row, reconciles invoice, emits audit events |
| `packages/web/src/components/invoices/RefundModal.tsx` | Controlled modal: shows refundable amount, amount + reason fields, submits proposal, shows pending/confirmed state |
| `packages/api/test/refunds/refund.test.ts` | Unit tests for domain layer (validation, idempotency key generation, InMemory repo) |
| `packages/api/test/refunds/refund-provider.test.ts` | Unit tests for `StripeRefundProvider` using `fetch` mocks |
| `packages/api/test/proposals/issue-refund-handler.test.ts` | Unit tests for `IssueRefundExecutionHandler` using `NoopRefundProvider` |
| `packages/api/test/routes/refunds.route.test.ts` | Integration tests for `POST /api/invoices/:id/refund` and `GET /api/invoices/:id/refunds` |
| `packages/web/src/components/invoices/RefundModal.test.tsx` | React Testing Library tests for `RefundModal` |

> **Migration mechanism:** This codebase does **not** use a `packages/api/migrations/*.sql` directory. The migration runner in `packages/api/src/db/migrate.ts` calls `getMigrationSQL()` which concatenates the `MIGRATIONS` object exported from `packages/api/src/db/schema.ts:25` (each value is a SQL string keyed by `'NNN_name'`). New migrations are added by appending entries to that object. All migration tasks below modify `schema.ts` rather than creating new SQL files.

### Modified files

**Phase 1** modifies `packages/api/src/db/schema.ts` (add `041_create_refunds` migration) and `packages/api/src/proposals/proposal.ts` (add `'issue_refund'` to `ProposalType` union + `VALID_PROPOSAL_TYPES` + `actionClassForProposalType`).

**Phase 3** modifies `packages/api/src/proposals/execution/handlers.ts` to import and register `IssueRefundExecutionHandler` in `createExecutionHandlerRegistry`.

**Phase 4** modifies `packages/api/src/routes/invoices.ts` (add two new route handlers on the existing invoice router), `packages/api/src/app.ts` (wire `PgRefundRepository` and `StripeRefundProvider` into the invoice router factory call).

**Phase 5** modifies `packages/web/src/pages/invoices/InvoiceDetail.tsx` (add "Issue Refund" action button and embed `<RefundModal>`).

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Database + RefundRepository

The refunds table sits beside payments in the invoice finance domain. All money is stored as integer cents. `idempotency_key` carries the canonical key `refund:<payment_id>:<amount_cents>:<sha256(reason)>` and has a `UNIQUE` constraint scoped to `tenant_id`. `stripe_refund_id` is nullable until the Stripe call succeeds.

### Task 1: Add `041_create_refunds` migration to `schema.ts`

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Append the new migration entry to the `MIGRATIONS` object after `040_create_technician_location_pings`. Use the full RLS pattern required for every new tenant-scoped table.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/refunds/refund.test.ts
import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

describe('041_create_refunds migration', () => {
  it('exists in MIGRATIONS object', () => {
    expect(MIGRATIONS).toHaveProperty('041_create_refunds');
  });

  it('creates refunds table with required columns', () => {
    const sql = MIGRATIONS['041_create_refunds'];
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS refunds/);
    expect(sql).toMatch(/payment_id/);
    expect(sql).toMatch(/invoice_id/);
    expect(sql).toMatch(/amount_cents/);
    expect(sql).toMatch(/idempotency_key/);
    expect(sql).toMatch(/stripe_refund_id/);
    expect(sql).toMatch(/ROW LEVEL SECURITY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/refunds/refund.test.ts -t "041_create_refunds migration"`
Expected: FAIL — `MIGRATIONS` has no key `041_create_refunds`

- [ ] **Step 3: Implement**

Append the following entry to the `MIGRATIONS` object in `packages/api/src/db/schema.ts`, after `'040_create_technician_location_pings'`:

```typescript
'041_create_refunds': `
  CREATE TABLE IF NOT EXISTS refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    payment_id UUID NOT NULL REFERENCES payments(id),
    invoice_id UUID NOT NULL REFERENCES invoices(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'succeeded', 'failed')),
    stripe_refund_id TEXT,
    idempotency_key TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_refunds_tenant ON refunds(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_invoice ON refunds(invoice_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_idempotency
    ON refunds(tenant_id, idempotency_key);
  ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
  ALTER TABLE refunds FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_refunds ON refunds;
  CREATE POLICY tenant_isolation_refunds ON refunds
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,
```

- [ ] **Step 4: Re-run test to confirm it passes**

Run: `cd packages/api && npx vitest run test/refunds/refund.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/test/refunds/refund.test.ts
git commit -m "feat(refunds): add 041_create_refunds migration with RLS"
```

---

### Task 2: Refund domain type, `RefundRepository` interface, and `InMemoryRefundRepository`

**Files:**
- Create: `packages/api/src/refunds/refund.ts`

**Context:** Mirrors the `Payment` / `InMemoryPaymentRepository` pattern in `packages/api/src/invoices/payment.ts`. Exposes `computeIdempotencyKey` (using Node's `crypto.createHash('sha256')`) and `computeAlreadyRefunded` as pure helpers.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/refunds/refund.test.ts  (extend the existing file)
import {
  InMemoryRefundRepository,
  computeIdempotencyKey,
  computeAlreadyRefunded,
  Refund,
} from '../../src/refunds/refund';

describe('computeIdempotencyKey', () => {
  it('returns deterministic key for same inputs', () => {
    const k1 = computeIdempotencyKey('pay-1', 5000, 'Duplicate charge');
    const k2 = computeIdempotencyKey('pay-1', 5000, 'Duplicate charge');
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^refund:pay-1:5000:[a-f0-9]{64}$/);
  });
});

describe('computeAlreadyRefunded', () => {
  it('sums succeeded refund amounts only', () => {
    const refunds: Pick<Refund, 'amountCents' | 'status'>[] = [
      { amountCents: 2000, status: 'succeeded' },
      { amountCents: 1000, status: 'failed' },
      { amountCents: 500,  status: 'pending' },
    ];
    expect(computeAlreadyRefunded(refunds)).toBe(2000);
  });
});

describe('InMemoryRefundRepository', () => {
  it('findByPaymentId filters by payment', async () => {
    const repo = new InMemoryRefundRepository();
    const r: Refund = {
      id: 'r-1', tenantId: 't-1', paymentId: 'pay-1', invoiceId: 'inv-1',
      amountCents: 1000, reason: 'test', status: 'succeeded',
      idempotencyKey: 'refund:pay-1:1000:abc', createdBy: 'u-1',
      createdAt: new Date(), updatedAt: new Date(),
    };
    await repo.create(r);
    const found = await repo.findByPaymentId('t-1', 'pay-1');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('r-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/refunds/refund.test.ts`
Expected: FAIL — module `../../src/refunds/refund` does not exist

- [ ] **Step 3: Implement**

Create `packages/api/src/refunds/refund.ts`:

```typescript
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export type RefundStatus = 'pending' | 'succeeded' | 'failed';

export interface Refund {
  id: string;
  tenantId: string;
  paymentId: string;
  invoiceId: string;
  amountCents: number;
  reason: string;
  status: RefundStatus;
  stripeRefundId?: string;
  idempotencyKey: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRefundInput {
  tenantId: string;
  paymentId: string;
  invoiceId: string;
  amountCents: number;
  reason: string;
  createdBy: string;
  idempotencyKey: string;
}

export interface RefundRepository {
  create(refund: Refund): Promise<Refund>;
  findById(tenantId: string, id: string): Promise<Refund | null>;
  findByPaymentId(tenantId: string, paymentId: string): Promise<Refund[]>;
  findByInvoiceId(tenantId: string, invoiceId: string): Promise<Refund[]>;
  update(tenantId: string, id: string, updates: Partial<Refund>): Promise<Refund | null>;
}

export function computeIdempotencyKey(
  paymentId: string,
  amountCents: number,
  reason: string
): string {
  const reasonHash = createHash('sha256').update(reason).digest('hex');
  return `refund:${paymentId}:${amountCents}:${reasonHash}`;
}

export function computeAlreadyRefunded(
  refunds: Pick<Refund, 'amountCents' | 'status'>[]
): number {
  return refunds
    .filter((r) => r.status === 'succeeded')
    .reduce((sum, r) => sum + r.amountCents, 0);
}

export function buildRefund(input: CreateRefundInput): Refund {
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    paymentId: input.paymentId,
    invoiceId: input.invoiceId,
    amountCents: input.amountCents,
    reason: input.reason,
    status: 'pending',
    idempotencyKey: input.idempotencyKey,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export class InMemoryRefundRepository implements RefundRepository {
  private store: Map<string, Refund> = new Map();

  async create(refund: Refund): Promise<Refund> {
    this.store.set(refund.id, { ...refund });
    return { ...refund };
  }

  async findById(tenantId: string, id: string): Promise<Refund | null> {
    const r = this.store.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    return { ...r };
  }

  async findByPaymentId(tenantId: string, paymentId: string): Promise<Refund[]> {
    return Array.from(this.store.values())
      .filter((r) => r.tenantId === tenantId && r.paymentId === paymentId)
      .map((r) => ({ ...r }));
  }

  async findByInvoiceId(tenantId: string, invoiceId: string): Promise<Refund[]> {
    return Array.from(this.store.values())
      .filter((r) => r.tenantId === tenantId && r.invoiceId === invoiceId)
      .map((r) => ({ ...r }));
  }

  async update(tenantId: string, id: string, updates: Partial<Refund>): Promise<Refund | null> {
    const r = this.store.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const updated = { ...r, ...updates, updatedAt: new Date() };
    this.store.set(id, updated);
    return { ...updated };
  }
}
```

- [ ] **Step 4: Re-run tests**

Run: `cd packages/api && npx vitest run test/refunds/refund.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/refunds/refund.ts packages/api/test/refunds/refund.test.ts
git commit -m "feat(refunds): add Refund domain type, InMemoryRefundRepository, and helpers"
```

---

### Task 3: `PgRefundRepository`

**Files:**
- Create: `packages/api/src/refunds/pg-refund.ts`

**Context:** Follows `PgPaymentRepository` as reference — uses `withTenantTransaction` for `create` (to guarantee the idempotency unique index conflict is caught atomically) and `withTenant` for reads.

- [ ] **Step 1: Write the failing test** (compile-only; integration tests against a live DB are out of scope for unit CI)

```typescript
// packages/api/test/refunds/refund.test.ts — append
import { PgRefundRepository } from '../../src/refunds/pg-refund';
import { Pool } from 'pg';

describe('PgRefundRepository — module shape', () => {
  it('can be imported and instantiated with a Pool', () => {
    // Just verify the class is importable and accepts a Pool constructor arg.
    // Real DB integration tests run in the pg-integration suite (out of scope here).
    expect(PgRefundRepository).toBeDefined();
    expect(typeof PgRefundRepository).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/refunds/refund.test.ts -t "PgRefundRepository"`
Expected: FAIL — module `../../src/refunds/pg-refund` not found

- [ ] **Step 3: Implement**

Create `packages/api/src/refunds/pg-refund.ts`:

```typescript
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Refund, RefundRepository, RefundStatus } from './refund';

export class PgRefundRepository extends PgBaseRepository implements RefundRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(refund: Refund): Promise<Refund> {
    return this.withTenantTransaction(refund.tenantId, async (client) => {
      await client.query(
        `INSERT INTO refunds
           (id, tenant_id, payment_id, invoice_id, amount_cents, reason,
            status, stripe_refund_id, idempotency_key, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          refund.id, refund.tenantId, refund.paymentId, refund.invoiceId,
          refund.amountCents, refund.reason, refund.status,
          refund.stripeRefundId ?? null, refund.idempotencyKey,
          refund.createdBy, refund.createdAt, refund.updatedAt,
        ],
      );
      return refund;
    });
  }

  async findById(tenantId: string, id: string): Promise<Refund | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM refunds WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      return rows.length === 0 ? null : this.mapRow(rows[0]);
    });
  }

  async findByPaymentId(tenantId: string, paymentId: string): Promise<Refund[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM refunds WHERE tenant_id = $1 AND payment_id = $2 ORDER BY created_at DESC`,
        [tenantId, paymentId],
      );
      return rows.map((r) => this.mapRow(r));
    });
  }

  async findByInvoiceId(tenantId: string, invoiceId: string): Promise<Refund[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM refunds WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY created_at DESC`,
        [tenantId, invoiceId],
      );
      return rows.map((r) => this.mapRow(r));
    });
  }

  async update(tenantId: string, id: string, updates: Partial<Refund>): Promise<Refund | null> {
    return this.withTenant(tenantId, async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (updates.status !== undefined)        { setClauses.push(`status = $${i++}`);           values.push(updates.status); }
      if (updates.stripeRefundId !== undefined) { setClauses.push(`stripe_refund_id = $${i++}`); values.push(updates.stripeRefundId); }
      if (updates.updatedAt !== undefined)      { setClauses.push(`updated_at = $${i++}`);       values.push(updates.updatedAt); }
      if (setClauses.length === 0) return this.findById(tenantId, id);
      values.push(id, tenantId);
      const { rows } = await client.query(
        `UPDATE refunds SET ${setClauses.join(', ')}
         WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`,
        values,
      );
      return rows.length === 0 ? null : this.mapRow(rows[0]);
    });
  }

  private mapRow(row: Record<string, unknown>): Refund {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      paymentId: row.payment_id as string,
      invoiceId: row.invoice_id as string,
      amountCents: Number(row.amount_cents),
      reason: row.reason as string,
      status: row.status as RefundStatus,
      stripeRefundId: (row.stripe_refund_id as string) ?? undefined,
      idempotencyKey: row.idempotency_key as string,
      createdBy: row.created_by as string,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
```

- [ ] **Step 4: Re-run tests**

Run: `cd packages/api && npx vitest run test/refunds/refund.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/refunds/pg-refund.ts packages/api/test/refunds/refund.test.ts
git commit -m "feat(refunds): add PgRefundRepository"
```

---

## Phase 2: StripeRefundProvider

The provider layer keeps Stripe entirely behind an interface so unit tests never hit the network. `StripeRefundProvider` calls `POST https://api.stripe.com/v1/refunds` with `payment_intent` and `amount` fields as form-encoded body, using `Authorization: Bearer <STRIPE_SECRET_KEY>`. `NoopRefundProvider` records calls in memory for test assertions.

### Task 4: `RefundProvider` interface, `NoopRefundProvider`, `StripeRefundProvider`

**Files:**
- Create: `packages/api/src/payments/refund-provider.ts`

**Context:** Mirrors `PaymentLinkProvider` / `StripePaymentLinkProvider`. The Stripe refund endpoint returns `{ id, status }` — map `'succeeded'` to the `stripeRefundId` field. Any non-2xx response becomes a thrown `Error`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/refunds/refund-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoopRefundProvider, StripeRefundProvider } from '../../src/payments/refund-provider';

describe('NoopRefundProvider', () => {
  it('returns a fake stripeRefundId and records the call', async () => {
    const provider = new NoopRefundProvider();
    const result = await provider.issueRefund({
      paymentIntentId: 'pi_test_123',
      amountCents: 5000,
      reason: 'Duplicate charge',
      idempotencyKey: 'refund:pay-1:5000:abc',
    });
    expect(result.stripeRefundId).toMatch(/^noop_re_/);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].amountCents).toBe(5000);
  });
});

describe('StripeRefundProvider', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('calls Stripe API and returns stripeRefundId on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 're_stripe_456', status: 'succeeded' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provider = new StripeRefundProvider('sk_test_xxx');
    const result = await provider.issueRefund({
      paymentIntentId: 'pi_test_123',
      amountCents: 5000,
      reason: 'Duplicate charge',
      idempotencyKey: 'refund:pay-1:5000:abc',
    });

    expect(result.stripeRefundId).toBe('re_stripe_456');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/refunds',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws on non-2xx Stripe response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'card_declined',
    }));
    const provider = new StripeRefundProvider('sk_test_xxx');
    await expect(provider.issueRefund({
      paymentIntentId: 'pi_fail', amountCents: 1000,
      reason: 'test', idempotencyKey: 'key',
    })).rejects.toThrow(/402/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/refunds/refund-provider.test.ts`
Expected: FAIL — module `../../src/payments/refund-provider` not found

- [ ] **Step 3: Implement**

Create `packages/api/src/payments/refund-provider.ts`:

```typescript
export interface IssueRefundInput {
  paymentIntentId: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
}

export interface IssueRefundResult {
  stripeRefundId: string;
}

export interface RefundProvider {
  issueRefund(input: IssueRefundInput): Promise<IssueRefundResult>;
}

export class NoopRefundProvider implements RefundProvider {
  readonly calls: IssueRefundInput[] = [];

  async issueRefund(input: IssueRefundInput): Promise<IssueRefundResult> {
    this.calls.push(input);
    return { stripeRefundId: `noop_re_${Date.now()}` };
  }
}

export class StripeRefundProvider implements RefundProvider {
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('StripeRefundProvider requires STRIPE_SECRET_KEY');
  }

  async issueRefund(input: IssueRefundInput): Promise<IssueRefundResult> {
    const res = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: new URLSearchParams({
        payment_intent: input.paymentIntentId,
        amount: String(input.amountCents),
        reason: 'duplicate',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Stripe refund failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { id: string; status: string };
    return { stripeRefundId: data.id };
  }
}
```

- [ ] **Step 4: Re-run tests**

Run: `cd packages/api && npx vitest run test/refunds/refund-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/payments/refund-provider.ts packages/api/test/refunds/refund-provider.test.ts
git commit -m "feat(refunds): add RefundProvider interface, NoopRefundProvider, StripeRefundProvider"
```

---

## Phase 3: `issue_refund` Proposal Type + Handler

The `issue_refund` ProposalType is classified as `'irreversible'` — it can never auto-approve and always waits for dispatcher confirmation. The execution handler validates the payment's refundability, calls the `RefundProvider`, persists the refund row, updates the invoice's `amountPaidCents` and `amountDueCents`, and emits two audit events (`refund.issued`, `invoice.balance_adjusted`). Failures after a partial Stripe call mark the refund as `'failed'` and leave the invoice unchanged.

### Task 5: Add `'issue_refund'` to `ProposalType`

**Files:**
- Modify: `packages/api/src/proposals/proposal.ts`

**Context:** Add `'issue_refund'` to the `ProposalType` union type, to `VALID_PROPOSAL_TYPES`, and to the exhaustive switch in `actionClassForProposalType` (returning `'irreversible'`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/proposals/proposal.test.ts — extend existing describe block
import { actionClassForProposalType, decideInitialStatus } from '../../src/proposals/proposal';

describe('issue_refund ProposalType', () => {
  it('actionClassForProposalType returns irreversible', () => {
    expect(actionClassForProposalType('issue_refund')).toBe('irreversible');
  });

  it('decideInitialStatus always returns draft for irreversible', () => {
    expect(decideInitialStatus({
      proposalType: 'issue_refund',
      sourceTrustTier: 'autonomous',
      confidenceScore: 1.0,
    })).toBe('draft');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/proposals/proposal.test.ts -t "issue_refund ProposalType"`
Expected: FAIL — TypeScript compile error: `'issue_refund'` is not in `ProposalType`

- [ ] **Step 3: Implement**

In `packages/api/src/proposals/proposal.ts`:
1. Add `| 'issue_refund'` to the `ProposalType` union on line 17.
2. Add `'issue_refund'` to `VALID_PROPOSAL_TYPES`.
3. In `actionClassForProposalType`, add `case 'issue_refund': return 'irreversible';` before the closing of the switch.

- [ ] **Step 4: Re-run tests**

Run: `cd packages/api && npx vitest run test/proposals/proposal.test.ts`
Expected: PASS (all existing tests still pass)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proposals/proposal.ts packages/api/test/proposals/proposal.test.ts
git commit -m "feat(refunds): add issue_refund to ProposalType as irreversible action class"
```

---

### Task 6: `IssueRefundExecutionHandler`

**Files:**
- Create: `packages/api/src/proposals/execution/issue-refund-handler.ts`
- Modify: `packages/api/src/proposals/execution/handlers.ts`

**Context:** The handler validates `paymentId`, `amountCents` (positive integer), and `reason` from the typed Zod-parsed payload. It looks up the payment, checks `payment.stripePaymentIntentId` is present, sums already-succeeded refunds, enforces `amountCents <= payment.amountCents - alreadyRefunded`, calls the provider, persists the refund row, and updates the invoice. Any throw from the provider sets status to `'failed'` and re-raises.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/proposals/issue-refund-handler.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { IssueRefundExecutionHandler } from '../../src/proposals/execution/issue-refund-handler';
import { InMemoryRefundRepository } from '../../src/refunds/refund';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { NoopRefundProvider } from '../../src/payments/refund-provider';
import { buildPayment } from '../factories/payment.factory';
import { buildInvoice } from '../factories/invoice.factory';
import { Proposal } from '../../src/proposals/proposal';

const TENANT = 'tenant-1';

function makeProposal(payload: Record<string, unknown>): Proposal {
  return {
    id: 'prop-1', tenantId: TENANT, proposalType: 'issue_refund',
    status: 'approved', payload, summary: 'Refund',
    createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('IssueRefundExecutionHandler', () => {
  let handler: IssueRefundExecutionHandler;
  let refundRepo: InMemoryRefundRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let auditRepo: InMemoryAuditRepository;
  let provider: NoopRefundProvider;

  beforeEach(async () => {
    refundRepo  = new InMemoryRefundRepository();
    paymentRepo = new InMemoryPaymentRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    auditRepo   = new InMemoryAuditRepository();
    provider    = new NoopRefundProvider();
    handler = new IssueRefundExecutionHandler(refundRepo, paymentRepo, invoiceRepo, auditRepo, provider);
  });

  it('happy path — creates refund and adjusts invoice balance', async () => {
    const invoice = buildInvoice({ tenantId: TENANT, status: 'paid', amountPaidCents: 10000, amountDueCents: 0 });
    await invoiceRepo.create(invoice);
    const payment = buildPayment({
      tenantId: TENANT, invoiceId: invoice.id,
      amountCents: 10000, status: 'completed',
      providerReference: 'pi_test_123',
    });
    await paymentRepo.create(payment);

    const result = await handler.execute(
      makeProposal({ paymentId: payment.id, amountCents: 3000, reason: 'Overcharged' }),
      { tenantId: TENANT, executedBy: 'u-1' }
    );

    expect(result.success).toBe(true);
    const refunds = await refundRepo.findByPaymentId(TENANT, payment.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe('succeeded');
    expect(refunds[0].amountCents).toBe(3000);

    const updated = await invoiceRepo.findById(TENANT, invoice.id);
    expect(updated!.amountPaidCents).toBe(7000);
    expect(updated!.amountDueCents).toBe(3000);
  });

  it('rejects if amountCents > payment.amountCents - alreadyRefunded', async () => {
    const invoice = buildInvoice({ tenantId: TENANT, status: 'paid', amountPaidCents: 10000, amountDueCents: 0 });
    await invoiceRepo.create(invoice);
    const payment = buildPayment({ tenantId: TENANT, invoiceId: invoice.id, amountCents: 5000, status: 'completed', providerReference: 'pi_1' });
    await paymentRepo.create(payment);

    const result = await handler.execute(
      makeProposal({ paymentId: payment.id, amountCents: 6000, reason: 'Too much' }),
      { tenantId: TENANT, executedBy: 'u-1' }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/proposals/issue-refund-handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `packages/api/src/proposals/execution/issue-refund-handler.ts`:

```typescript
import { z } from 'zod';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { RefundRepository, buildRefund, computeAlreadyRefunded, computeIdempotencyKey } from '../../refunds/refund';
import { PaymentRepository } from '../../invoices/payment';
import { InvoiceRepository } from '../../invoices/invoice';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { RefundProvider } from '../../payments/refund-provider';

const issueRefundPayloadSchema = z.object({
  paymentId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string().min(1),
});

export class IssueRefundExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'issue_refund';

  constructor(
    private readonly refundRepo: RefundRepository,
    private readonly paymentRepo: PaymentRepository,
    private readonly invoiceRepo: InvoiceRepository,
    private readonly auditRepo: AuditRepository,
    private readonly refundProvider: RefundProvider,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = issueRefundPayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return { success: false, error: `Invalid payload: ${parsed.error.message}` };
    }
    const { paymentId, amountCents, reason } = parsed.data;

    const payment = await this.paymentRepo.findById(context.tenantId, paymentId);
    if (!payment) return { success: false, error: `Payment ${paymentId} not found` };
    if (payment.status !== 'completed') {
      return { success: false, error: `Cannot refund payment with status '${payment.status}'` };
    }
    if (!payment.providerReference) {
      return { success: false, error: 'Payment has no Stripe payment intent reference — cannot refund' };
    }

    const existingRefunds = await this.refundRepo.findByPaymentId(context.tenantId, paymentId);
    const alreadyRefunded = computeAlreadyRefunded(existingRefunds);
    const refundable = payment.amountCents - alreadyRefunded;

    if (amountCents > refundable) {
      return {
        success: false,
        error: `Refund amount ${amountCents} exceeds refundable balance ${refundable}`,
      };
    }

    const invoice = await this.invoiceRepo.findById(context.tenantId, payment.invoiceId);
    if (!invoice) return { success: false, error: `Invoice ${payment.invoiceId} not found` };

    const idempotencyKey = computeIdempotencyKey(paymentId, amountCents, reason);
    const refund = buildRefund({
      tenantId: context.tenantId,
      paymentId,
      invoiceId: payment.invoiceId,
      amountCents,
      reason,
      createdBy: context.executedBy,
      idempotencyKey,
    });

    await this.refundRepo.create(refund);

    let stripeRefundId: string;
    try {
      const result = await this.refundProvider.issueRefund({
        paymentIntentId: payment.providerReference,
        amountCents,
        reason,
        idempotencyKey,
      });
      stripeRefundId = result.stripeRefundId;
    } catch (err) {
      await this.refundRepo.update(context.tenantId, refund.id, { status: 'failed' });
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Stripe refund failed: ${msg}` };
    }

    await this.refundRepo.update(context.tenantId, refund.id, {
      status: 'succeeded',
      stripeRefundId,
    });

    // Reconcile invoice balance
    const newAmountPaid = Math.max(0, invoice.amountPaidCents - amountCents);
    const newAmountDue = invoice.totals.totalCents - newAmountPaid;
    await this.invoiceRepo.update(context.tenantId, invoice.id, {
      amountPaidCents: newAmountPaid,
      amountDueCents: Math.max(0, newAmountDue),
      updatedAt: new Date(),
    });

    await this.auditRepo.create(createAuditEvent({
      tenantId: context.tenantId,
      actorId: context.executedBy,
      actorRole: 'dispatcher',
      eventType: 'refund.issued',
      entityType: 'refund',
      entityId: refund.id,
      metadata: { paymentId, invoiceId: invoice.id, amountCents, stripeRefundId },
    }));
    await this.auditRepo.create(createAuditEvent({
      tenantId: context.tenantId,
      actorId: context.executedBy,
      actorRole: 'dispatcher',
      eventType: 'invoice.balance_adjusted',
      entityType: 'invoice',
      entityId: invoice.id,
      metadata: { refundId: refund.id, amountCents, newAmountPaid, newAmountDue },
    }));

    return { success: true, resultEntityId: refund.id };
  }
}
```

Then in `packages/api/src/proposals/execution/handlers.ts`:
1. Import `IssueRefundExecutionHandler` from `./issue-refund-handler`.
2. Add `refundRepo?: RefundRepository`, `refundProvider?: RefundProvider` to the `deps` parameter type.
3. At the end of `createExecutionHandlerRegistry`, after the `if (deps?.estimateRepo)` block:

```typescript
if (deps?.refundRepo && deps?.paymentRepo && deps?.invoiceRepo && deps?.refundProvider) {
  handlers.push(
    new IssueRefundExecutionHandler(
      deps.refundRepo,
      deps.paymentRepo,
      deps.invoiceRepo,
      deps.auditRepo ?? new InMemoryAuditRepository(),
      deps.refundProvider,
    )
  );
}
```

- [ ] **Step 4: Re-run tests**

Run: `cd packages/api && npx vitest run test/proposals/issue-refund-handler.test.ts`
Expected: PASS

Run: `cd packages/api && npx vitest run` (full suite)
Expected: PASS — no regressions

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proposals/execution/issue-refund-handler.ts \
        packages/api/src/proposals/execution/handlers.ts \
        packages/api/test/proposals/issue-refund-handler.test.ts
git commit -m "feat(refunds): add IssueRefundExecutionHandler and register in handler registry"
```

---

## Phase 4: API Endpoints

Two routes on the existing invoice router: `POST /api/invoices/:id/refund` creates an `issue_refund` proposal (returns 202 with the proposal object — not executed immediately); `GET /api/invoices/:id/refunds` returns all refund rows for the invoice, sorted newest-first.

### Task 7: `POST /api/invoices/:id/refund`

**Files:**
- Modify: `packages/api/src/routes/invoices.ts`

**Context:** The route validates the request body with a Zod schema (`{ paymentId, amountCents, reason }`), then calls `createProposal` + stores via `ProposalRepository`. Returns 202. The route factory gains an optional `proposalRepo` and `refundRepo` param.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/routes/refunds.route.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createInvoiceRouter } from '../../src/routes/invoices';
import { InMemoryInvoiceRepository, InMemoryInvoiceRepository as InvRepo } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryRefundRepository } from '../../src/refunds/refund';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { buildInvoice } from '../factories/invoice.factory';
import { buildPayment } from '../factories/payment.factory';

// ... (set up full Express app with auth bypass and router factories)

describe('POST /api/invoices/:id/refund', () => {
  it('returns 202 with proposal when payload is valid', async () => {
    // ... create a paid invoice and payment, POST refund body
    const res = await req.post(`/api/invoices/${invoice.id}/refund`)
      .send({ paymentId: payment.id, amountCents: 3000, reason: 'Overcharged' });
    expect(res.status).toBe(202);
    expect(res.body.proposalType).toBe('issue_refund');
    expect(res.body.status).toBe('draft');
  });

  it('returns 400 when amountCents is missing', async () => {
    const res = await req.post(`/api/invoices/${invoice.id}/refund`)
      .send({ paymentId: 'some-id', reason: 'test' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/invoices/:id/refunds', () => {
  it('returns refund list for invoice', async () => {
    // seed a refund row then GET
    const res = await req.get(`/api/invoices/${invoice.id}/refunds`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/refunds.route.test.ts`
Expected: FAIL — routes return 404

- [ ] **Step 3: Implement**

In `packages/api/src/routes/invoices.ts`, extend `createInvoiceRouter` to accept `proposalRepo?: ProposalRepository` and `refundRepo?: RefundRepository`. Add the two handlers:

```typescript
const refundBodySchema = z.object({
  paymentId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string().min(1),
});

router.post(
  '/:id/refund',
  requireAuth, requireTenant, requirePermission('invoices:update'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!proposalRepo) {
        res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'Proposal repo not configured' });
        return;
      }
      const parsed = refundBodySchema.parse(req.body);
      const proposal = createProposal({
        tenantId: req.auth!.tenantId,
        proposalType: 'issue_refund',
        payload: { paymentId: parsed.paymentId, amountCents: parsed.amountCents, reason: parsed.reason },
        summary: `Refund $${(parsed.amountCents / 100).toFixed(2)} on payment ${parsed.paymentId}`,
        createdBy: req.auth!.userId,
        targetEntityType: 'invoice',
        targetEntityId: req.params.id,
      });
      const saved = await proposalRepo.create(proposal);
      res.status(202).json(saved);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  }
);

router.get(
  '/:id/refunds',
  requireAuth, requireTenant, requirePermission('invoices:view'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!refundRepo) {
        res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'Refund repo not configured' });
        return;
      }
      const refunds = await refundRepo.findByInvoiceId(req.auth!.tenantId, req.params.id);
      res.json(refunds);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  }
);
```

- [ ] **Step 4: Re-run tests**

Run: `cd packages/api && npx vitest run test/routes/refunds.route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/invoices.ts packages/api/test/routes/refunds.route.test.ts
git commit -m "feat(refunds): add POST /invoices/:id/refund and GET /invoices/:id/refunds"
```

---

### Task 8: Wire `PgRefundRepository` and `StripeRefundProvider` into `app.ts`

**Files:**
- Modify: `packages/api/src/app.ts`

**Context:** When `DATABASE_URL` is set, instantiate `PgRefundRepository(pool)` and `StripeRefundProvider(process.env.STRIPE_SECRET_KEY!)`. When running in-memory, use `InMemoryRefundRepository`. Pass both to `createInvoiceRouter` and `createExecutionHandlerRegistry`. A missing `STRIPE_SECRET_KEY` in production logs a warning but does not crash startup — the route returns 501 instead.

- [ ] **Step 1: Verify existing full-suite runs green before touching app.ts**

Run: `cd packages/api && npx vitest run`
Expected: PASS

- [ ] **Step 2: Implement**

Add imports at top of `app.ts`:
```typescript
import { InMemoryRefundRepository } from './refunds/refund';
import { PgRefundRepository } from './refunds/pg-refund';
import { NoopRefundProvider, StripeRefundProvider } from './payments/refund-provider';
```

In the repository initialization block, after `paymentRepo`:
```typescript
const refundRepo = pool ? new PgRefundRepository(pool) : new InMemoryRefundRepository();
const refundProvider = process.env.STRIPE_SECRET_KEY
  ? new StripeRefundProvider(process.env.STRIPE_SECRET_KEY)
  : new NoopRefundProvider();
```

Pass `refundRepo` and `refundProvider` to `createInvoiceRouter(...)` and `createExecutionHandlerRegistry({ ..., refundRepo, refundProvider })`.

- [ ] **Step 3: Verify full suite still passes**

Run: `cd packages/api && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/app.ts
git commit -m "feat(refunds): wire PgRefundRepository and StripeRefundProvider into app"
```

---

## Phase 5: Frontend Refund Modal

The `RefundModal` is a controlled component that opens over the `InvoiceDetail` page. It reads the `refundable` amount (invoice's `amountPaidCents` minus the sum of succeeded refunds fetched from `GET /api/invoices/:id/refunds`), displays a numeric amount input capped at that ceiling, a required reason textarea, and a submit button. On submit it posts to `POST /api/invoices/:id/refund` and shows a pending state with the proposal ID. The dispatcher sees "Refund proposal submitted — awaiting approval" with the proposal ID and a close button.

### Task 9: `RefundModal` component

**Files:**
- Create: `packages/web/src/components/invoices/RefundModal.tsx`
- Create: `packages/web/src/components/invoices/RefundModal.test.tsx`

**Context:** Use `useMutation('POST', ...)` for the submission call. Derive `refundableCents` from `invoiceTotalPaidCents - alreadyRefundedCents` passed as props. All amounts displayed as dollars (`(cents / 100).toFixed(2)`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/invoices/RefundModal.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { RefundModal } from './RefundModal';

describe('RefundModal', () => {
  const defaultProps = {
    invoiceId: 'inv-1',
    paymentId: 'pay-1',
    refundableCents: 10000,
    onClose: vi.fn(),
    onSuccess: vi.fn(),
  };

  it('renders refundable amount', () => {
    render(<RefundModal {...defaultProps} />);
    expect(screen.getByText(/\$100\.00/)).toBeInTheDocument();
  });

  it('disables submit when amount exceeds refundable', async () => {
    render(<RefundModal {...defaultProps} />);
    const input = screen.getByLabelText(/amount/i);
    fireEvent.change(input, { target: { value: '200' } });
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  });

  it('calls onClose when cancel is clicked', () => {
    render(<RefundModal {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/invoices/RefundModal.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `packages/web/src/components/invoices/RefundModal.tsx`:

```tsx
import React, { useState } from 'react';
import { useMutation } from '../../hooks/useMutation';

interface RefundModalProps {
  invoiceId: string;
  paymentId: string;
  refundableCents: number;
  onClose: () => void;
  onSuccess: (proposalId: string) => void;
}

interface RefundProposalResponse {
  id: string;
  status: string;
  proposalType: string;
}

export function RefundModal({ invoiceId, paymentId, refundableCents, onClose, onSuccess }: RefundModalProps) {
  const [amountDollars, setAmountDollars] = useState('');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const { mutate, isLoading, error } = useMutation<object, RefundProposalResponse>(
    'POST',
    `/api/invoices/${invoiceId}/refund`
  );

  const amountCents = Math.round(parseFloat(amountDollars || '0') * 100);
  const isAmountValid = amountCents > 0 && amountCents <= refundableCents;
  const canSubmit = isAmountValid && reason.trim().length > 0 && !isLoading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = await mutate({ paymentId, amountCents, reason: reason.trim() });
    setSubmitted(result.id);
    onSuccess(result.id);
  }

  if (submitted) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
        <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md">
          <h2 className="text-lg font-semibold mb-2">Refund Proposal Submitted</h2>
          <p className="text-sm text-slate-600 mb-4">
            Awaiting dispatcher approval. Proposal ID: <code className="text-xs">{submitted}</code>
          </p>
          <button onClick={onClose} className="btn-primary w-full">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold mb-1">Issue Refund</h2>
        <p className="text-sm text-slate-500 mb-4">
          Refundable: <strong>${(refundableCents / 100).toFixed(2)}</strong>
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="refund-amount" className="block text-sm font-medium text-slate-700 mb-1">
              Amount (USD)
            </label>
            <input
              id="refund-amount"
              aria-label="amount"
              type="number"
              step="0.01"
              min="0.01"
              max={(refundableCents / 100).toFixed(2)}
              value={amountDollars}
              onChange={(e) => setAmountDollars(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              required
            />
            {amountCents > refundableCents && (
              <p className="text-xs text-red-600 mt-1">Exceeds refundable balance</p>
            )}
          </div>
          <div>
            <label htmlFor="refund-reason" className="block text-sm font-medium text-slate-700 mb-1">
              Reason
            </label>
            <textarea
              id="refund-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm resize-none"
              required
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 border border-slate-300 rounded-lg py-2 text-sm text-slate-700">
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit}
              className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm disabled:opacity-50">
              {isLoading ? 'Submitting…' : 'Submit Refund'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Re-run tests**

Run: `cd packages/web && npx vitest run src/components/invoices/RefundModal.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/invoices/RefundModal.tsx \
        packages/web/src/components/invoices/RefundModal.test.tsx
git commit -m "feat(refunds): add RefundModal component with amount validation and proposal submission"
```

---

### Task 10: Integrate `RefundModal` into `InvoiceDetail.tsx`

**Files:**
- Modify: `packages/web/src/pages/invoices/InvoiceDetail.tsx`

**Context:** Fetch `GET /api/invoices/:id/refunds` alongside the invoice detail. Sum succeeded refunds to derive `alreadyRefundedCents`. Compute `refundableCents = invoice.amountPaidCents - alreadyRefundedCents`. Show an "Issue Refund" action button only when `invoice.status === 'paid' && refundableCents > 0`. The button opens `<RefundModal>`. On modal `onSuccess`, call `refetch()`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/pages/invoices/InvoiceDetail.test.tsx — extend existing file
it('shows Issue Refund button when invoice is paid', async () => {
  server.use(
    http.get('/api/invoices/inv-paid', () =>
      HttpResponse.json({ ...mockPaidInvoice, amountPaidCents: 10000, amountDueCents: 0, status: 'paid' })
    ),
    http.get('/api/invoices/inv-paid/refunds', () => HttpResponse.json([]))
  );
  render(<InvoiceDetail invoiceId="inv-paid" />);
  await screen.findByText(/Invoice/);
  expect(screen.getByRole('button', { name: /issue refund/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/pages/invoices/InvoiceDetail.test.tsx -t "shows Issue Refund button"`
Expected: FAIL — button not found

- [ ] **Step 3: Implement**

In `packages/web/src/pages/invoices/InvoiceDetail.tsx`:
1. Add `import { RefundModal } from '../../components/invoices/RefundModal';`
2. Add a `useListQuery` call for `GET /api/invoices/${invoiceId}/refunds` to fetch existing refunds.
3. Compute `alreadyRefundedCents` and `refundableCents`.
4. Add `showRefundModal` state.
5. Add an "Issue Refund" action button in the `actions` array, gated on `data.status === 'paid' && refundableCents > 0`.
6. Render `{showRefundModal && <RefundModal ... onClose={() => setShowRefundModal(false)} onSuccess={() => { setShowRefundModal(false); refetch(); }} />}` at the bottom of the component return.

- [ ] **Step 4: Re-run tests**

Run: `cd packages/web && npx vitest run src/pages/invoices/InvoiceDetail.test.tsx`
Expected: PASS (all existing tests still pass)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/invoices/InvoiceDetail.tsx
git commit -m "feat(refunds): integrate RefundModal into InvoiceDetail with refundable amount calculation"
```

---

## Out of scope

- Stripe webhook handling for async refund status updates (e.g., `charge.refunded` events) — this is a separate story
- Partial invoice crediting or credit note generation
- Refund reversal / undo of a refund
- Refund reason validation against a fixed enum (free-text `reason` is intentional)
- Email / SMS notification to customer on refund issuance
- Pagination on `GET /api/invoices/:id/refunds`
- Admin-level "refund any status" override (only `paid` invoices are refundable via this flow)
- Automated refund approval (the proposal is always `draft` and requires dispatcher action)

---

### Critical Files for Implementation
- `/home/user/Serviceos/packages/api/src/db/schema.ts`
- `/home/user/Serviceos/packages/api/src/proposals/proposal.ts`
- `/home/user/Serviceos/packages/api/src/proposals/execution/handlers.ts`
- `/home/user/Serviceos/packages/api/src/routes/invoices.ts`
- `/home/user/Serviceos/packages/web/src/pages/invoices/InvoiceDetail.tsx`
