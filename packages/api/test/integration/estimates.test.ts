import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — estimates', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Test',
      lastName: 'Customer',
      displayName: 'Test Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId: customerId,
      street1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId: customerId,
      locationId: locationId,
      jobNumber: 'JOB-001',
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates estimate and retrieves via findById', async () => {
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Labor', 2, 7500, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      const estimate = await estimateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        estimateNumber: 'EST-001',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await estimateRepo.findById(tenant.tenantId, estimate.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe('draft');
      expect(found!.estimateNumber).toBe('EST-001');
      expect(found!.lineItems).toHaveLength(1);
    });

    it('updates estimate and reflects in findById', async () => {
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Labor', 1, 5000, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      const estimate = await estimateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        estimateNumber: 'EST-002',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await estimateRepo.update(tenant.tenantId, estimate.id, {
        status: 'sent',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('sent');

      const found = await estimateRepo.findById(tenant.tenantId, estimate.id);
      expect(found!.status).toBe('sent');
    });

    it('finds estimates by tenant', async () => {
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Labor', 1, 3000, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      await estimateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        estimateNumber: 'EST-003',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const estimates = await estimateRepo.findByTenant(tenant.tenantId);
      expect(estimates.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Secret Labor', 1, 10000, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      const estimate = await estimateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        estimateNumber: 'EST-SECRET',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await estimateRepo.findById(otherTenant.tenantId, estimate.id);
      expect(found).toBeNull();
    });
  });
});