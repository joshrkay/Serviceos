import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import {
  resolveDiscountPolicy,
  DEFAULT_DISCOUNT_POLICY,
} from '../../src/settings/settings';

/**
 * V2 negotiation (D-013), migration 183. Pins the real discount-policy
 * columns + their CHECK constraints against Postgres — a mocked-Pool test is
 * never proof a query works (CLAUDE.md). Proves: the columns exist and
 * round-trip, fail-closed DB defaults apply to legacy rows, and the money
 * CHECKs reject out-of-range writes the app validator would also catch.
 */
describe('Postgres integration — discount policy (migration 183)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedSettings(tenantId: string): Promise<void> {
    const now = new Date();
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId,
      businessName: 'Discount Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
  }

  it('applies fail-closed DB defaults to a freshly-created row (V1 behavior)', async () => {
    const tenant = await createTestTenant(pool);
    await seedSettings(tenant.tenantId);

    const found = await settingsRepo.findByTenant(tenant.tenantId);
    expect(found).not.toBeNull();
    // DB defaults: discount_max_bps 0, discount_never_below_catalog true,
    // discount_floor_cents NULL → undefined.
    expect(found!.discountMaxBps).toBe(0);
    expect(found!.discountNeverBelowCatalog).toBe(true);
    expect(found!.discountFloorCents).toBeUndefined();
    expect(resolveDiscountPolicy(found)).toEqual(DEFAULT_DISCOUNT_POLICY);
  });

  it('round-trips an opt-in policy through the real columns', async () => {
    const tenant = await createTestTenant(pool);
    await seedSettings(tenant.tenantId);

    const updated = await settingsRepo.update(tenant.tenantId, {
      discountMaxBps: 1500,
      discountFloorCents: 5000,
      discountNeverBelowCatalog: false,
    });
    expect(updated!.discountMaxBps).toBe(1500);
    expect(updated!.discountFloorCents).toBe(5000);
    expect(updated!.discountNeverBelowCatalog).toBe(false);

    const found = await settingsRepo.findByTenant(tenant.tenantId);
    expect(resolveDiscountPolicy(found)).toEqual({
      maxBps: 1500,
      floorCents: 5000,
      neverBelowCatalog: false,
    });
  });

  it('clears the absolute floor with an explicit null', async () => {
    const tenant = await createTestTenant(pool);
    await seedSettings(tenant.tenantId);
    await settingsRepo.update(tenant.tenantId, { discountFloorCents: 5000 });

    const cleared = await settingsRepo.update(tenant.tenantId, { discountFloorCents: null });
    expect(cleared!.discountFloorCents).toBeUndefined();
  });

  describe('CHECK constraints reject out-of-range money writes', () => {
    it('rejects a ceiling above 100% (discount_max_bps > 10000)', async () => {
      const tenant = await createTestTenant(pool);
      await seedSettings(tenant.tenantId);
      await expect(
        settingsRepo.update(tenant.tenantId, { discountMaxBps: 20000 }),
      ).rejects.toThrow();
    });

    it('rejects a negative ceiling (discount_max_bps < 0)', async () => {
      const tenant = await createTestTenant(pool);
      await seedSettings(tenant.tenantId);
      await expect(
        settingsRepo.update(tenant.tenantId, { discountMaxBps: -5 }),
      ).rejects.toThrow();
    });

    it('rejects a negative absolute floor (discount_floor_cents < 0)', async () => {
      const tenant = await createTestTenant(pool);
      await seedSettings(tenant.tenantId);
      await expect(
        settingsRepo.update(tenant.tenantId, { discountFloorCents: -100 }),
      ).rejects.toThrow();
    });
  });
});
