import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';

describe('Postgres integration — jobs', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let locationId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
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

    locationId = crypto.randomUUID();
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
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates job and retrieves via findById', async () => {
      const job = await jobRepo.create({
        id: crypto.randomUUID(),
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

      const found = await jobRepo.findById(tenant.tenantId, job.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe('scheduled');
      expect(found!.customerId).toBe(customerId);
    });

    it('updates job and reflects in findById', async () => {
      const job = await jobRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        customerId: customerId,
        locationId: locationId,
        jobNumber: 'JOB-002',
        summary: 'Another job',
        status: 'scheduled',
        priority: 'normal',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await jobRepo.update(tenant.tenantId, job.id, {
        status: 'in_progress',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('in_progress');

      const found = await jobRepo.findById(tenant.tenantId, job.id);
      expect(found!.status).toBe('in_progress');
    });

    it('finds jobs by tenant', async () => {
      await jobRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        customerId: customerId,
        locationId: locationId,
        jobNumber: 'JOB-003',
        summary: 'Third job',
        status: 'new',
        priority: 'normal',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const jobs = await jobRepo.findByTenant(tenant.tenantId);
      expect(jobs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const job = await jobRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        customerId: customerId,
        locationId: locationId,
        jobNumber: 'JOB-004',
        summary: 'Secret job',
        status: 'scheduled',
        priority: 'normal',
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await jobRepo.findById(otherTenant.tenantId, job.id);
      expect(found).toBeNull();
    });
  });
});