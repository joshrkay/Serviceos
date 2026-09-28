import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { createLogger } from '../../src/logging/logger';
import {
  runOverageSettlementReconciliation,
  STALE_AFTER_MS,
  type OverageSettlementReconciliationDeps,
} from '../../src/workers/overage-settlement-reconciliation';
import type { CallUsageBillingService } from '../../src/billing/call-usage-billing';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-10-15T12:00:00Z');
const TENANT = '11111111-1111-1111-1111-111111111111';
const HOUR = 60 * 60 * 1000;

interface StaleRow {
  id: string;
  tenant_id: string;
  status: 'pending' | 'failed';
  billable_minutes: number;
  overage_minutes: number;
  customer_charge_cents: number;
  stripe_invoice_item_id: string | null;
}

interface GapTenant {
  id: string;
  plan_id: string;
  current_period_start: Date;
  current_period_end: Date;
}

function fakePool(opts: { stale: StaleRow[]; tenants: GapTenant[]; covered: boolean }) {
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('JOIN tenants')) {
        return { rows: opts.stale, rowCount: opts.stale.length } as unknown as QueryResult;
      }
      if (sql.includes('FROM tenants')) {
        return { rows: opts.tenants, rowCount: opts.tenants.length } as unknown as QueryResult;
      }
      if (sql.includes('FROM call_usage_settlements')) {
        return {
          rows: opts.covered ? [{ id: 's1', status: 'completed' }] : [],
          rowCount: opts.covered ? 1 : 0,
        } as unknown as QueryResult;
      }
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }),
  } as unknown as Pool;
  return pool;
}

function staleRow(over: Partial<StaleRow> = {}): StaleRow {
  return {
    id: 'settle_1',
    tenant_id: TENANT,
    status: 'failed',
    billable_minutes: 60,
    overage_minutes: 40,
    customer_charge_cents: 5000,
    stripe_invoice_item_id: null,
    ...over,
  };
}

function gapTenant(over: Partial<GapTenant> = {}): GapTenant {
  // Current period: Oct 1 → Nov 1; previous closed period: Sep 1 → Oct 1.
  return {
    id: TENANT,
    plan_id: 'starter',
    current_period_start: new Date('2026-10-01T00:00:00Z'),
    current_period_end: new Date('2026-11-01T00:00:00Z'),
    ...over,
  };
}

function makeDeps(opts: {
  stale?: StaleRow[];
  tenants?: GapTenant[];
  covered?: boolean;
  seconds?: number;
}): { deps: OverageSettlementReconciliationDeps; billing: { retrySettlement: ReturnType<typeof vi.fn>; settlePeriod: ReturnType<typeof vi.fn> } } {
  const billing = {
    retrySettlement: vi.fn(async () => ({ invoiceItemId: 'ii_retry', alreadyCompleted: false })),
    settlePeriod: vi.fn(async () => ({ planId: 'starter', billableMinutes: 60, overageMinutes: 40, customerChargeCents: 5000, invoiceItemId: 'ii_gap' })),
  };
  return {
    billing,
    deps: {
      pool: fakePool({ stale: opts.stale ?? [], tenants: opts.tenants ?? [], covered: opts.covered ?? false }),
      logger,
      billing: billing as unknown as CallUsageBillingService,
      callUsage: { sumBillableSeconds: async () => opts.seconds ?? 0 },
      overageCaps: { get: async () => null },
      priceIdForPlan: (planId) => `price_${planId}`,
      now: () => NOW,
    },
  };
}

describe('runOverageSettlementReconciliation', () => {
  it('no-ops without a pool or billing service', async () => {
    const { deps } = makeDeps({});
    const noPool = await runOverageSettlementReconciliation({ ...deps, pool: null });
    expect(noPool.staleChecked).toBe(0);
    const noBilling = await runOverageSettlementReconciliation({ ...deps, billing: null });
    expect(noBilling.staleChecked).toBe(0);
  });

  it('re-drives stale failed settlements through retrySettlement', async () => {
    const { deps, billing } = makeDeps({ stale: [staleRow()] });
    const res = await runOverageSettlementReconciliation(deps);
    expect(res.staleChecked).toBe(1);
    expect(res.staleRetried).toBe(1);
    expect(res.staleCompleted).toBe(1);
    expect(billing.retrySettlement).toHaveBeenCalledWith({
      tenantId: TENANT,
      settlement: expect.objectContaining({ id: 'settle_1', status: 'failed' }),
    });
  });

  it('counts a settlement that keeps failing without stopping the sweep', async () => {
    const { deps, billing } = makeDeps({ stale: [staleRow(), staleRow({ id: 'settle_2' })] });
    billing.retrySettlement.mockRejectedValueOnce(new Error('still down'));
    const res = await runOverageSettlementReconciliation(deps);
    expect(res.staleCompleted).toBe(1);
    expect(res.staleStillFailing).toBe(1);
  });

  it('backfills a gap period where metered usage was never billed', async () => {
    // 90 billable minutes on Starter (20 included) → 70 overage minutes.
    const { deps, billing } = makeDeps({ tenants: [gapTenant()], seconds: 90 * 60 });
    const res = await runOverageSettlementReconciliation(deps);
    expect(res.gapsChecked).toBe(1);
    expect(res.gapsBackfilled).toBe(1);
    expect(billing.settlePeriod).toHaveBeenCalledWith({
      tenantId: TENANT,
      periodStart: new Date('2026-08-31T00:00:00Z'),
      periodEnd: new Date('2026-10-01T00:00:00Z'),
      subscriptionPriceId: 'price_starter',
    });
  });

  it('skips a gap period that already has a settlement row', async () => {
    const { deps, billing } = makeDeps({ tenants: [gapTenant()], covered: true, seconds: 90 * 60 });
    const res = await runOverageSettlementReconciliation(deps);
    expect(res.gapsChecked).toBe(1);
    expect(res.gapsBackfilled).toBe(0);
    expect(billing.settlePeriod).not.toHaveBeenCalled();
  });

  it('skips a gap period whose usage stays inside the plan bundle', async () => {
    const { deps, billing } = makeDeps({ tenants: [gapTenant()], seconds: 10 * 60 });
    const res = await runOverageSettlementReconciliation(deps);
    expect(res.gapsBackfilled).toBe(0);
    expect(billing.settlePeriod).not.toHaveBeenCalled();
  });
});

describe('STALE_AFTER_MS', () => {
  it('gives the webhook path an hour before re-driving', () => {
    expect(STALE_AFTER_MS).toBe(1 * HOUR);
  });
});
