/**
 * Unit cover for per-period AI-minute overage settlement with in-memory
 * collaborators. test/integration/call-usage-settlement.test.ts proves the
 * same flows against real Postgres.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CallUsageBillingService,
  PgCallUsageSettlementRepository,
  type CallUsageSettlementRepository,
  type CallUsageSettlementRow,
} from '../../src/billing/call-usage-billing';
import { fakePool } from './fake-pool';

const START = new Date('2026-10-01T00:00:00Z');
const END = new Date('2026-11-01T00:00:00Z');
const TENANT = '11111111-1111-4111-8111-111111111111';

function memorySettlements(): CallUsageSettlementRepository & { rows: Map<string, CallUsageSettlementRow & { error?: string }> } {
  const rows = new Map<string, CallUsageSettlementRow & { error?: string }>();
  return {
    rows,
    async ensurePending(input) {
      const key = `${input.tenantId}:${input.periodStart.toISOString()}`;
      if (!rows.has(key)) {
        rows.set(key, {
          id: input.id, status: 'pending', billableMinutes: input.billableMinutes,
          overageMinutes: input.overageMinutes, customerChargeCents: input.customerChargeCents,
          stripeInvoiceItemId: null,
        });
      }
      return { ...rows.get(key)! };
    },
    async markCompleted(_t, id, itemId) {
      for (const r of rows.values()) if (r.id === id) Object.assign(r, { status: 'completed', stripeInvoiceItemId: itemId });
    },
    async fail(_t, id, error) {
      for (const r of rows.values()) if (r.id === id) Object.assign(r, { status: 'failed', error });
    },
  };
}

function service(opts: { seconds: number; cap?: number | null; fetchFn?: typeof fetch; customer?: string | null; onAlert?: () => void }) {
  const settlementRepo = memorySettlements();
  const svc = new CallUsageBillingService({
    pool: fakePool((sql) =>
      sql.includes('stripe_customer_id') ? { rows: [{ stripe_customer_id: opts.customer === undefined ? 'cus_x' : opts.customer, owner_id: 'u_owner' }] } : undefined,
    ),
    settlementRepo,
    callUsage: { sumBillableSeconds: async () => opts.seconds },
    overageCaps: { get: async () => opts.cap },
    stripeApiKey: 'sk_test',
    fetchFn: opts.fetchFn ?? ((async () => new Response(JSON.stringify({ id: 'ii_1' }))) as unknown as typeof fetch),
    planForPriceId: (p) => (p === 'price_starter' ? 'starter' : p === 'price_growth' ? 'growth' : null),
    ...(opts.onAlert ? { onAlert: opts.onAlert } : {}),
  });
  const settle = (price = 'price_starter') =>
    svc.settlePeriod({ tenantId: 't1', periodStart: START, periodEnd: END, subscriptionPriceId: price, stripeInvoiceId: 'in_1' });
  return { settle, settlementRepo };
}

describe('CallUsageBillingService (unit)', () => {
  it('invoices 60 Starter minutes as one $50.00 item and completes the settlement', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: 'ii_1' })));
    const { settle, settlementRepo } = service({ seconds: 3_600, fetchFn: fetchFn as unknown as typeof fetch });

    expect(await settle()).toEqual({
      planId: 'starter', billableMinutes: 60, overageMinutes: 40, customerChargeCents: 5_000, invoiceItemId: 'ii_1',
    });
    const body = fetchFn.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('amount')).toBe('5000');
    expect(body.get('description')).toBe('AI answering minutes over plan: 40 at $1.25/min');
    expect([...settlementRepo.rows.values()][0].status).toBe('completed');
  });

  it('completes a period inside the bundle without calling Stripe', async () => {
    const fetchFn = vi.fn();
    const { settle } = service({ seconds: 1_200, fetchFn: fetchFn as unknown as typeof fetch });
    expect((await settle()).invoiceItemId).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns the stored result for an already-completed period', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: 'ii_1' })));
    const { settle } = service({ seconds: 3_600, fetchFn: fetchFn as unknown as typeof fetch });
    await settle();
    expect((await settle()).invoiceItemId).toBe('ii_1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('marks the settlement failed, alerts and throws when Stripe errors or returns no id', async () => {
    const onAlert = vi.fn();
    const down = service({ seconds: 3_600, onAlert, fetchFn: (async () => new Response('down', { status: 503 })) as unknown as typeof fetch });
    await expect(down.settle()).rejects.toThrow(/failed \(503\)/);
    expect([...down.settlementRepo.rows.values()][0].status).toBe('failed');
    expect(onAlert).toHaveBeenCalledWith(expect.objectContaining({ rule: 'call_settlement_failed' }));

    const noId = service({ seconds: 3_600, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
    await expect(noId.settle()).rejects.toThrow(/returned no id/);
  });

  it('refuses an unknown subscription price and a tenant with no Stripe customer', async () => {
    await expect(service({ seconds: 3_600 }).settle('price_other')).rejects.toThrow(/Unknown subscription price/);
    await expect(service({ seconds: 3_600, customer: null }).settle()).rejects.toThrow(/no Stripe customer/);
  });

  it('applies the owner cap', async () => {
    const { settle } = service({ seconds: 200 * 60, cap: 20_000 });
    expect((await settle()).customerChargeCents).toBe(20_000);
  });
});

describe('PgCallUsageSettlementRepository (unit)', () => {
  it('maps the pending row and issues completion / failure updates', async () => {
    const pool = fakePool((sql) =>
      sql.includes('INSERT INTO call_usage_settlements')
        ? { rows: [{ id: 's1', status: 'pending', billable_minutes: 60, overage_minutes: 40, customer_charge_cents: 5000, stripe_invoice_item_id: null }] }
        : { rows: [], rowCount: 1 },
    );
    const repo = new PgCallUsageSettlementRepository(pool);
    expect(
      await repo.ensurePending({
        id: 's1', tenantId: TENANT, periodStart: START, periodEnd: END, planId: 'starter',
        billableSeconds: 3_600, billableMinutes: 60, overageMinutes: 40, customerChargeCents: 5_000,
      }),
    ).toEqual({ id: 's1', status: 'pending', billableMinutes: 60, overageMinutes: 40, customerChargeCents: 5_000, stripeInvoiceItemId: null });
    await repo.markCompleted(TENANT, 's1', 'ii_1');
    await repo.fail(TENANT, 's1', 'x'.repeat(600));
    expect(pool.calls.some((c) => c.includes("status = 'completed'"))).toBe(true);
    expect(pool.calls.some((c) => c.includes("status = 'failed'"))).toBe(true);
  });
});
