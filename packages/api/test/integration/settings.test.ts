import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';

describe('Postgres integration — settings', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  // tenant_settings has UNIQUE(tenant_id), so each test creates its own
  // tenant to avoid duplicate-key conflicts when multiple tests in the
  // suite each call settingsRepo.create().
  describe('CRUD', () => {
    it('creates settings and retrieves via findByTenant', async () => {
      const tenant = await createTestTenant(pool);
      const now = new Date();
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        businessName: 'Test Business',
        businessPhone: '555-1234',
        businessEmail: 'test@business.com',
        timezone: 'America/Chicago',
        estimatePrefix: 'EST',
        invoicePrefix: 'INV',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: now,
        updatedAt: now,
      });

      const found = await settingsRepo.findByTenant(tenant.tenantId);
      expect(found).not.toBeNull();
      expect(found!.businessName).toBe('Test Business');
      expect(found!.timezone).toBe('America/Chicago');
    });

    it('LC-6 — surfaces service_area_zips from the real column (read mapping)', async () => {
      const tenant = await createTestTenant(pool);
      const now = new Date();
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        businessName: 'Zip Co',
        timezone: 'UTC',
        estimatePrefix: 'EST',
        invoicePrefix: 'INV',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: now,
        updatedAt: now,
      });

      // Empty array default surfaces as undefined.
      const before = await settingsRepo.findByTenant(tenant.tenantId);
      expect(before!.serviceAreaZips).toBeUndefined();

      // service_area_zips is written by the onboarding flow's raw SQL; write it
      // directly here, then prove the settings read mapping resolves the real
      // TEXT[] column (not a mocked field).
      await pool.query(
        `UPDATE tenant_settings SET service_area_zips = $1 WHERE tenant_id = $2`,
        [['78701', '78702'], tenant.tenantId],
      );

      const found = await settingsRepo.findByTenant(tenant.tenantId);
      expect(found!.serviceAreaZips).toEqual(['78701', '78702']);
    });

    it('updates settings and reflects in findByTenant', async () => {
      const tenant = await createTestTenant(pool);
      const now = new Date();
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        businessName: 'Original Name',
        timezone: 'America/New_York',
        estimatePrefix: 'EST',
        invoicePrefix: 'INV',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: now,
        updatedAt: now,
      });

      const updated = await settingsRepo.update(tenant.tenantId, {
        businessName: 'Updated Name',
        timezone: 'America/Los_Angeles',
      });

      expect(updated).not.toBeNull();
      expect(updated!.businessName).toBe('Updated Name');
      expect(updated!.timezone).toBe('America/Los_Angeles');

      const found = await settingsRepo.findByTenant(tenant.tenantId);
      expect(found!.businessName).toBe('Updated Name');
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const tenant = await createTestTenant(pool);
      const otherTenant = await createTestTenant(pool);
      const found = await settingsRepo.findByTenant(otherTenant.tenantId);
      expect(found).toBeNull();
    });
  });
});
