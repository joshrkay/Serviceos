import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgServiceBundleRepository } from '../../src/verticals/pg-bundles';

describe('Postgres integration — bundles', () => {
  let pool: Pool;
  let bundleRepo: PgServiceBundleRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    bundleRepo = new PgServiceBundleRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates bundle and retrieves via findById', async () => {
      const bundle = await bundleRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        verticalType: 'hvac',
        name: 'AC Tune-up Bundle',
        description: 'AC tune-up with filter replacement',
        categoryIds: ['maintenance', 'repair'],
        lineItemTemplates: [
          { description: 'Labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 7500, taxable: true, sortOrder: 1, isOptional: false },
          { description: 'Filter', category: 'material', defaultQuantity: 1, defaultUnitPriceCents: 2000, taxable: true, sortOrder: 2, isOptional: false },
        ],
        triggerKeywords: ['tune-up', 'maintenance', 'annual'],
        isActive: true,
        usageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await bundleRepo.findById(tenant.tenantId, bundle.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('AC Tune-up Bundle');
    });

    it('updates bundle and reflects in findById', async () => {
      const bundle = await bundleRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        verticalType: 'plumbing',
        name: 'Original Bundle',
        categoryIds: ['repair'],
        lineItemTemplates: [
          { description: 'Labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 5000, taxable: true, sortOrder: 1, isOptional: false },
        ],
        triggerKeywords: ['leak'],
        isActive: true,
        usageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await bundleRepo.update(tenant.tenantId, bundle.id, {
        name: 'Updated Bundle',
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Updated Bundle');
    });

    it('finds bundles by tenant', async () => {
      await bundleRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        verticalType: 'hvac',
        name: 'Another Bundle',
        categoryIds: ['repair'],
        lineItemTemplates: [
          { description: 'Labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 3000, taxable: true, sortOrder: 1, isOptional: false },
        ],
        triggerKeywords: ['repair'],
        isActive: true,
        usageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const bundles = await bundleRepo.findByTenant(tenant.tenantId);
      expect(bundles.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const bundle = await bundleRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        verticalType: 'hvac',
        name: 'Secret Bundle',
        categoryIds: ['secret'],
        lineItemTemplates: [
          { description: 'Labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 10000, taxable: true, sortOrder: 1, isOptional: false },
        ],
        triggerKeywords: ['secret'],
        isActive: true,
        usageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await bundleRepo.findById(otherTenant.tenantId, bundle.id);
      expect(found).toBeNull();
    });
  });
});