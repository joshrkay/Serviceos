import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '../../src/logging/logger';
import { PgCallUsageRepository } from '../../src/billing/call-usage-events';
import { PgOverageCapStore } from '../../src/billing/overage-cap';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';
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

function fakePool(opts: { stale: StaleRow[]; tenants: GapTenant[]; covered: boolean | ((tenantId: string) => boolean) }) {
  return fakeTenantPool((sql, values) => {
    if (sql.includes('JOIN tenants')) return { rows: opts.stale };
    if (sql.includes('FROM tenants')) return { rows: opts.tenants };
    if (sql.includes('FROM call_usage_settlements')) {
      const covered = typeof opts.covered === 'function' ? opts.covered(String(values?.[0])) : opts.covered;
      return { rows: covered ? [{ id: 's1', status: 'completed' }] : [] };
    }
    return undefined;
  });
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
      pool: fakePool({ stale: opts.stale ?? [], tenants: opts.tenants ?? [], covered: opts.covered ?? false }).pool,
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

// Raw-pg audit 2026-10-23 §4 P2.7 — the gap backfill's covering-settlement
// read ran on the raw pool as the principal. Each gap tenant's reads (that
// one, its metered usage and its overage cap) now share ONE tenant session
// under the RLS runtime role, closed before settlePeriod's Stripe call.
// Real Postgres: test/integration/overage-reconciliation-tenant-context.test.ts.
describe('runOverageSettlementReconciliation — each gap tenant\'s reads in one tenant session', () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const COVERING = /FROM call_usage_settlements/;
  const USAGE = /FROM call_usage_events/;
  const CAP = /SELECT ai_overage_cap_cents, ai_overage_uncapped FROM tenant_settings/;

  /** The worker's real repositories on a fake pool that answers their reads. */
  function sessionDeps(opts: { tenants: GapTenant[]; covered?: (tenantId: string) => boolean; failUsageFor?: string }) {
    const fake = fakeTenantPool((sql, values) => {
      if (sql.includes('JOIN tenants')) return { rows: [] };
      if (sql.includes('FROM tenants')) return { rows: opts.tenants };
      if (COVERING.test(sql)) return { rows: opts.covered?.(String(values?.[0])) ? [{ id: 's1', status: 'completed' }] : [] };
      if (USAGE.test(sql)) {
        if (values?.[0] === opts.failUsageFor) throw new Error('usage read failed');
        return { rows: [{ seconds: String(90 * 60) }] };
      }
      if (CAP.test(sql)) return { rows: [{ ai_overage_cap_cents: null, ai_overage_uncapped: false }] };
      return undefined;
    });
    const openAtSettle: number[] = [];
    const billing = {
      retrySettlement: vi.fn(),
      settlePeriod: vi.fn(async () => {
        openAtSettle.push(fake.open());
        return { planId: 'starter', billableMinutes: 90, overageMinutes: 70, customerChargeCents: 5000, invoiceItemId: 'ii' };
      }),
    };
    const deps: OverageSettlementReconciliationDeps = {
      pool: fake.pool,
      logger,
      billing: billing as unknown as CallUsageBillingService,
      callUsage: new PgCallUsageRepository(fake.pool),
      overageCaps: new PgOverageCapStore(fake.pool),
      priceIdForPlan: (planId) => `price_${planId}`,
      now: () => NOW,
    };
    return { fake, deps, billing, openAtSettle };
  }

  /** The statements of one checkout, normalised. */
  const onCheckout = (fake: ReturnType<typeof fakeTenantPool>, checkout: number) =>
    fake.statements.filter((s) => s.checkout === checkout).map((s) => s.sql.replace(/\s+/g, ' ').trim());

  it('the covering read, the metered usage and the cap share one checkout: BEGIN, the GUC + role, three reads, COMMIT — closed before settlePeriod', async () => {
    const { fake, deps, billing, openAtSettle } = sessionDeps({ tenants: [gapTenant()] });

    const res = await runOverageSettlementReconciliation(deps);

    expect(res.gapsBackfilled).toBe(1);
    expect(billing.settlePeriod).toHaveBeenCalledTimes(1);
    expect(openAtSettle).toEqual([0]);
    // Checkouts 0 and 1 are the two global reads (stale settlements, gap tenants).
    expect(fake.checkouts()).toBe(3);
    const session = onCheckout(fake, 2);
    expect(session).toEqual([
      'BEGIN',
      expect.stringMatching(/^SELECT set_config\('app\.current_tenant_id'/),
      expect.stringMatching(COVERING),
      expect.stringMatching(USAGE),
      expect.stringMatching(CAP),
      'COMMIT',
    ]);
    const ctx = fake.statements.find((s) => s.checkout === 2 && /set_config/.test(s.sql));
    expect(ctx?.values).toEqual([TENANT]);
  });

  it('a covered period: the session ends after the covering read — no usage or cap read, nothing billed', async () => {
    const { fake, deps, billing } = sessionDeps({ tenants: [gapTenant()], covered: () => true });

    const res = await runOverageSettlementReconciliation(deps);

    expect(res).toMatchObject({ gapsChecked: 1, gapsBackfilled: 0 });
    expect(billing.settlePeriod).not.toHaveBeenCalled();
    expect(onCheckout(fake, 2)).toEqual([
      'BEGIN',
      expect.stringMatching(/^SELECT set_config/),
      expect.stringMatching(COVERING),
      'COMMIT',
    ]);
  });

  it('per-tenant isolation: a failed read rolls that tenant\'s session back, counts it, and the next tenant is still reconciled in its own', async () => {
    const { fake, deps, billing } = sessionDeps({
      tenants: [gapTenant(), gapTenant({ id: OTHER })],
      failUsageFor: TENANT,
    });

    const res = await runOverageSettlementReconciliation(deps);

    expect(res).toMatchObject({ gapsChecked: 2, gapsBackfilled: 1, failed: 1 });
    expect(billing.settlePeriod).toHaveBeenCalledWith(expect.objectContaining({ tenantId: OTHER }));
    expect(onCheckout(fake, 2)).toContain('ROLLBACK');
    expect(onCheckout(fake, 2)).not.toContain('COMMIT');
    expect(onCheckout(fake, 3).at(-1)).toBe('COMMIT');
    expect(fake.statements.find((s) => s.checkout === 3 && /set_config/.test(s.sql))?.values).toEqual([OTHER]);
    expect(fake.open()).toBe(0);
  });
});

describe('STALE_AFTER_MS', () => {
  it('gives the webhook path an hour before re-driving', () => {
    expect(STALE_AFTER_MS).toBe(1 * HOUR);
  });
});
