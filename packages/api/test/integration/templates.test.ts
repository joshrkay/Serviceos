import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';

describe('Postgres integration — templates', () => {
  let pool: Pool;
  let templateRepo: PgEstimateTemplateRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    templateRepo = new PgEstimateTemplateRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates template and retrieves via findById', async () => {
      const template = await templateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        verticalType: 'hvac',
        categoryId: 'ac-repair',
        name: 'AC Repair Template',
        description: 'Standard AC repair template',
        lineItemTemplates: [
          { description: 'Labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 7500, taxable: true, sortOrder: 1, isOptional: false },
        ],
        defaultDiscountCents: 0,
        defaultTaxRateBps: 825,
        isActive: true,
        usageCount: 0,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await templateRepo.findById(tenant.tenantId, template.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('AC Repair Template');
      expect(found!.verticalType).toBe('hvac');
    });

    it('updates template and reflects in findById', async () => {
      const template = await templateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        verticalType: 'plumbing',
        categoryId: 'leak-repair',
        name: 'Original Template',
        lineItemTemplates: [
          { description: 'Labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 5000, taxable: true, sortOrder: 1, isOptional: false },
        ],
        defaultDiscountCents: 0,
        defaultTaxRateBps: 825,
        isActive: true,
        usageCount: 0,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await templateRepo.update(tenant.tenantId, template.id, {
        name: 'Updated Template',
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Updated Template');
    });

    it('finds templates by tenant', async () => {
      await templateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        verticalType: 'hvac',
        categoryId: 'maintenance',
        name: 'Maintenance Template',
        lineItemTemplates: [
          { description: 'Labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 3000, taxable: true, sortOrder: 1, isOptional: false },
        ],
        defaultDiscountCents: 0,
        defaultTaxRateBps: 825,
        isActive: true,
        usageCount: 0,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const templates = await templateRepo.findByTenant(tenant.tenantId);
      expect(templates.length).toBeGreaterThanOrEqual(1);
    });

    it('increments usage count', async () => {
      const template = await templateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        verticalType: 'plumbing',
        categoryId: 'outlet-repair',
        name: 'Outlet Repair Template',
        lineItemTemplates: [
          { description: 'Labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 4000, taxable: true, sortOrder: 1, isOptional: false },
        ],
        defaultDiscountCents: 0,
        defaultTaxRateBps: 825,
        isActive: true,
        usageCount: 0,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await templateRepo.incrementUsage(tenant.tenantId, template.id);
      const found = await templateRepo.findById(tenant.tenantId, template.id);
      expect(found!.usageCount).toBe(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const template = await templateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        verticalType: 'hvac',
        categoryId: 'secret',
        name: 'Secret Template',
        lineItemTemplates: [
          { description: 'Labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: 10000, taxable: true, sortOrder: 1, isOptional: false },
        ],
        defaultDiscountCents: 0,
        defaultTaxRateBps: 825,
        isActive: true,
        usageCount: 0,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await templateRepo.findById(otherTenant.tenantId, template.id);
      expect(found).toBeNull();
    });
  });
});