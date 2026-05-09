import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';

describe('Postgres integration — settings', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    tenant = await createTestTenant(pool);

    // Each tenant can have at most one settings row (unique constraint).
    // Create it once here; individual tests read or update it.
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
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates settings and retrieves via findByTenant', async () => {
      const found = await settingsRepo.findByTenant(tenant.tenantId);
      expect(found).not.toBeNull();
      expect(found!.businessName).toBe('Test Business');
      expect(found!.timezone).toBe('America/Chicago');
    });

    it('updates settings and reflects in findByTenant', async () => {
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
      const otherTenant = await createTestTenant(pool);
      const found = await settingsRepo.findByTenant(otherTenant.tenantId);
      expect(found).toBeNull();
    });
  });
});
