import { describe, it, expect } from 'vitest';
import {
  resolveDiscountPolicy,
  DEFAULT_DISCOUNT_POLICY,
  validateUpdateSettingsInput,
  InMemorySettingsRepository,
  TenantSettings,
} from '../../src/settings/settings';
import { updateSettingsSchema } from '../../src/shared/contracts';

function makeSettings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  const now = new Date();
  return {
    id: 'settings-1',
    tenantId: 't1',
    businessName: 'Test Business',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('resolveDiscountPolicy — V2 negotiation (D-013)', () => {
  it('fail-closed for a null settings row (no tenant config)', () => {
    expect(resolveDiscountPolicy(null)).toEqual(DEFAULT_DISCOUNT_POLICY);
    // The default must be V1-equivalent: no discount, strictest grounding.
    expect(DEFAULT_DISCOUNT_POLICY).toEqual({
      maxBps: 0,
      floorCents: null,
      neverBelowCatalog: true,
    });
  });

  it('fail-closed for an unconfigured settings row', () => {
    expect(resolveDiscountPolicy(makeSettings())).toEqual({
      maxBps: 0,
      floorCents: null,
      neverBelowCatalog: true,
    });
  });

  it('passes a fully-configured opt-in policy through verbatim', () => {
    const policy = resolveDiscountPolicy(
      makeSettings({
        discountMaxBps: 1500,
        discountFloorCents: 5000,
        discountNeverBelowCatalog: false,
      }),
    );
    expect(policy).toEqual({ maxBps: 1500, floorCents: 5000, neverBelowCatalog: false });
  });

  it('accepts the boundary ceiling (100% = 10000 bps)', () => {
    expect(resolveDiscountPolicy(makeSettings({ discountMaxBps: 10000 })).maxBps).toBe(10000);
  });

  it('defensively resolves invalid maxBps to 0 (never trusts bad data)', () => {
    // Out of range / non-integer / negative all collapse to "no discount" —
    // the money core must never be tricked into selling below margin.
    for (const bad of [-5, 10001, 1.5, NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveDiscountPolicy(makeSettings({ discountMaxBps: bad })).maxBps).toBe(0);
    }
  });

  it('defensively resolves invalid floorCents to null', () => {
    for (const bad of [-1, 12.5, NaN]) {
      expect(resolveDiscountPolicy(makeSettings({ discountFloorCents: bad })).floorCents).toBe(
        null,
      );
    }
  });

  it('treats floorCents of 0 as a real floor (not nullish-collapsed)', () => {
    expect(resolveDiscountPolicy(makeSettings({ discountFloorCents: 0 })).floorCents).toBe(0);
  });

  it('defaults neverBelowCatalog to true when unset, honours explicit false', () => {
    expect(resolveDiscountPolicy(makeSettings()).neverBelowCatalog).toBe(true);
    expect(
      resolveDiscountPolicy(makeSettings({ discountNeverBelowCatalog: false })).neverBelowCatalog,
    ).toBe(false);
  });

  it('does not mutate the shared default object across calls', () => {
    const a = resolveDiscountPolicy(null);
    a.maxBps = 9999;
    expect(DEFAULT_DISCOUNT_POLICY.maxBps).toBe(0);
  });
});

describe('validateUpdateSettingsInput — discount policy ranges', () => {
  it('accepts in-range values and clears (null floor)', () => {
    expect(validateUpdateSettingsInput({ discountMaxBps: 0 })).toEqual([]);
    expect(validateUpdateSettingsInput({ discountMaxBps: 10000 })).toEqual([]);
    expect(validateUpdateSettingsInput({ discountFloorCents: 0 })).toEqual([]);
    expect(validateUpdateSettingsInput({ discountFloorCents: null })).toEqual([]);
    expect(
      validateUpdateSettingsInput({
        discountMaxBps: 1500,
        discountFloorCents: 5000,
        discountNeverBelowCatalog: true,
      }),
    ).toEqual([]);
  });

  it('rejects out-of-range / non-integer maxBps', () => {
    expect(validateUpdateSettingsInput({ discountMaxBps: -1 })).toContain(
      'discountMaxBps must be an integer between 0 and 10000',
    );
    expect(validateUpdateSettingsInput({ discountMaxBps: 10001 })).toContain(
      'discountMaxBps must be an integer between 0 and 10000',
    );
    expect(validateUpdateSettingsInput({ discountMaxBps: 1.5 })).toContain(
      'discountMaxBps must be an integer between 0 and 10000',
    );
  });

  it('rejects negative / non-integer floorCents', () => {
    expect(validateUpdateSettingsInput({ discountFloorCents: -1 })).toContain(
      'discountFloorCents must be a non-negative integer of cents',
    );
    expect(validateUpdateSettingsInput({ discountFloorCents: 9.99 })).toContain(
      'discountFloorCents must be a non-negative integer of cents',
    );
  });
});

describe('updateSettingsSchema (Zod) — discount policy passthrough', () => {
  it('accepts valid discount fields (route would otherwise strip them)', () => {
    const parsed = updateSettingsSchema.parse({
      discountMaxBps: 1500,
      discountFloorCents: 5000,
      discountNeverBelowCatalog: false,
    });
    expect(parsed.discountMaxBps).toBe(1500);
    expect(parsed.discountFloorCents).toBe(5000);
    expect(parsed.discountNeverBelowCatalog).toBe(false);
  });

  it('rejects an out-of-range ceiling at the contract boundary', () => {
    expect(() => updateSettingsSchema.parse({ discountMaxBps: 20000 })).toThrow();
    expect(() => updateSettingsSchema.parse({ discountMaxBps: -1 })).toThrow();
  });

  it('allows null to clear the absolute floor', () => {
    expect(updateSettingsSchema.parse({ discountFloorCents: null }).discountFloorCents).toBe(null);
  });
});

describe('TenantSettings discount columns — in-memory round-trip', () => {
  it('round-trips the discount policy through the repository update path', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.create(makeSettings({ tenantId: 't1', id: 'settings-t1' }));

    const updated = await repo.update('t1', {
      discountMaxBps: 2000,
      discountFloorCents: 7500,
      discountNeverBelowCatalog: false,
    });
    expect(updated?.discountMaxBps).toBe(2000);
    expect(updated?.discountFloorCents).toBe(7500);
    expect(updated?.discountNeverBelowCatalog).toBe(false);

    const fetched = await repo.findByTenant('t1');
    expect(resolveDiscountPolicy(fetched)).toEqual({
      maxBps: 2000,
      floorCents: 7500,
      neverBelowCatalog: false,
    });
  });

  it('defaults to undefined columns → V1 policy when never set', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.create(makeSettings({ tenantId: 't2', id: 'settings-t2' }));
    const fetched = await repo.findByTenant('t2');
    expect(fetched?.discountMaxBps).toBeUndefined();
    expect(resolveDiscountPolicy(fetched)).toEqual(DEFAULT_DISCOUNT_POLICY);
  });
});
