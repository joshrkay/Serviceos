/**
 * P2-036 V2 (Discount-policy engine — U1: data plane):
 *   - resolveDiscountPolicy fail-closes an unconfigured tenant to the
 *     V1-identical posture and reads configured values when present.
 *   - The settings validation (validateCommonSettingsFields, reached via
 *     updateSettings) rejects out-of-range bps, negative floors, and
 *     non-integer values while allowing explicit null (clear).
 *   - The PUT /api/settings contract (updateSettingsSchema) accepts the
 *     discount fields and round-trips them through the repo.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSettings,
  updateSettings,
  resolveDiscountPolicy,
  InMemorySettingsRepository,
  TenantSettings,
} from '../../src/settings/settings';
import { updateSettingsSchema } from '../../src/shared/contracts';

const TENANT = 'tenant-discount';

describe('resolveDiscountPolicy (P2-036 V2 U1)', () => {
  it('fail-closes to the V1-identical posture for a null settings row', () => {
    const policy = resolveDiscountPolicy(null);
    expect(policy).toEqual({
      maxDiscountBps: 0,
      absoluteFloorCents: null,
      neverBelowCatalog: true,
    });
  });

  it('fail-closes each field independently when columns are absent/undefined', () => {
    // A settings row that predates the migration: discount columns absent.
    const settings = { businessName: 'X' } as unknown as TenantSettings;
    const policy = resolveDiscountPolicy(settings);
    expect(policy.maxDiscountBps).toBe(0); // "no auto-allow" — every ask escalates
    expect(policy.absoluteFloorCents).toBeNull();
    expect(policy.neverBelowCatalog).toBe(true); // stricter default
  });

  it('reads configured values verbatim', () => {
    const settings = {
      businessName: 'X',
      discountMaxBps: 1500,
      discountFloorCents: 5000,
      discountNeverBelowCatalog: false,
    } as unknown as TenantSettings;
    expect(resolveDiscountPolicy(settings)).toEqual({
      maxDiscountBps: 1500,
      absoluteFloorCents: 5000,
      neverBelowCatalog: false,
    });
  });

  it('treats an explicit discountMaxBps of 0 as "no auto-allow" (not fail-through to a default)', () => {
    const settings = {
      businessName: 'X',
      discountMaxBps: 0,
      discountFloorCents: 0,
      discountNeverBelowCatalog: true,
    } as unknown as TenantSettings;
    const policy = resolveDiscountPolicy(settings);
    expect(policy.maxDiscountBps).toBe(0);
    // 0 is a real configured floor, distinct from the absent → null case.
    expect(policy.absoluteFloorCents).toBe(0);
  });
});

describe('discount-policy validation (service layer)', () => {
  let repo: InMemorySettingsRepository;

  beforeEach(async () => {
    repo = new InMemorySettingsRepository();
    await createSettings({ tenantId: TENANT, businessName: 'ACME HVAC' }, repo);
  });

  it('round-trips valid discount fields through updateSettings', async () => {
    const updated = await updateSettings(
      TENANT,
      {
        discountMaxBps: 2000,
        discountFloorCents: 7500,
        discountNeverBelowCatalog: false,
      },
      repo,
    );
    expect(updated?.discountMaxBps).toBe(2000);
    expect(updated?.discountFloorCents).toBe(7500);
    expect(updated?.discountNeverBelowCatalog).toBe(false);
  });

  it('allows explicit null to clear a discount column', async () => {
    await updateSettings(TENANT, { discountMaxBps: 1000 }, repo);
    const cleared = await updateSettings(TENANT, { discountMaxBps: null }, repo);
    expect(cleared?.discountMaxBps).toBeNull();
  });

  it('rejects discountMaxBps above 10000', async () => {
    await expect(
      updateSettings(TENANT, { discountMaxBps: 10001 }, repo),
    ).rejects.toThrow(/discountMaxBps/);
  });

  it('rejects a negative discountMaxBps', async () => {
    await expect(
      updateSettings(TENANT, { discountMaxBps: -1 }, repo),
    ).rejects.toThrow(/discountMaxBps/);
  });

  it('rejects a non-integer discountMaxBps', async () => {
    await expect(
      updateSettings(TENANT, { discountMaxBps: 12.5 }, repo),
    ).rejects.toThrow(/discountMaxBps/);
  });

  it('rejects a negative discountFloorCents', async () => {
    await expect(
      updateSettings(TENANT, { discountFloorCents: -100 }, repo),
    ).rejects.toThrow(/discountFloorCents/);
  });

  it('rejects a non-integer discountFloorCents', async () => {
    await expect(
      updateSettings(TENANT, { discountFloorCents: 99.99 }, repo),
    ).rejects.toThrow(/discountFloorCents/);
  });
});

describe('PUT /api/settings contract (updateSettingsSchema) — discount fields', () => {
  it('accepts the discount fields', () => {
    const parsed = updateSettingsSchema.parse({
      discountMaxBps: 2500,
      discountFloorCents: 9900,
      discountNeverBelowCatalog: true,
    });
    expect(parsed.discountMaxBps).toBe(2500);
    expect(parsed.discountFloorCents).toBe(9900);
    expect(parsed.discountNeverBelowCatalog).toBe(true);
  });

  it('accepts a payload that omits discount fields (untouched)', () => {
    const parsed = updateSettingsSchema.parse({ businessName: 'X' });
    expect(parsed.discountMaxBps).toBeUndefined();
    expect(parsed.discountFloorCents).toBeUndefined();
    expect(parsed.discountNeverBelowCatalog).toBeUndefined();
  });

  it('accepts explicit null to clear', () => {
    const parsed = updateSettingsSchema.parse({
      discountMaxBps: null,
      discountFloorCents: null,
      discountNeverBelowCatalog: null,
    });
    expect(parsed.discountMaxBps).toBeNull();
    expect(parsed.discountFloorCents).toBeNull();
    expect(parsed.discountNeverBelowCatalog).toBeNull();
  });

  it('rejects out-of-range, negative, and non-integer values', () => {
    expect(() => updateSettingsSchema.parse({ discountMaxBps: 10001 })).toThrow();
    expect(() => updateSettingsSchema.parse({ discountMaxBps: -1 })).toThrow();
    expect(() => updateSettingsSchema.parse({ discountMaxBps: 12.5 })).toThrow();
    expect(() => updateSettingsSchema.parse({ discountFloorCents: -1 })).toThrow();
    expect(() => updateSettingsSchema.parse({ discountFloorCents: 1.5 })).toThrow();
    expect(() =>
      updateSettingsSchema.parse({ discountNeverBelowCatalog: 'yes' }),
    ).toThrow();
  });
});
