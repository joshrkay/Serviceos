import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgCustomerRepository } from '../../src/customers/pg-customer';

describe('Postgres integration — locations', () => {
  let pool: Pool;
  let locationRepo: PgLocationRepository;
  let customerRepo: PgCustomerRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    locationRepo = new PgLocationRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
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
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates location and retrieves via findById', async () => {
      const location = await locationRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        customerId: customerId,
        label: 'Home',
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

      const found = await locationRepo.findById(tenant.tenantId, location.id);
      expect(found).not.toBeNull();
      expect(found!.street1).toBe('123 Main St');
      expect(found!.city).toBe('Austin');
      expect(found!.isPrimary).toBe(true);
    });

    it('updates location and reflects in findById', async () => {
      const location = await locationRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        customerId: customerId,
        street1: '456 Old St',
        city: 'Dallas',
        state: 'TX',
        postalCode: '75001',
        country: 'USA',
        isPrimary: false,
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await locationRepo.update(tenant.tenantId, location.id, {
        city: 'Houston',
        street1: '456 New St',
      });

      expect(updated).not.toBeNull();
      expect(updated!.city).toBe('Houston');
      expect(updated!.street1).toBe('456 New St');

      const found = await locationRepo.findById(tenant.tenantId, location.id);
      expect(found!.city).toBe('Houston');
    });

    it('finds locations by customer', async () => {
      await locationRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        customerId: customerId,
        street1: '789 Third St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78702',
        country: 'USA',
        isPrimary: false,
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const locations = await locationRepo.findByCustomer(tenant.tenantId, customerId);
      expect(locations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const location = await locationRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        customerId: customerId,
        street1: 'Secret Location',
        city: 'Secret City',
        state: 'TX',
        postalCode: '00000',
        country: 'USA',
        isPrimary: false,
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await locationRepo.findById(otherTenant.tenantId, location.id);
      expect(found).toBeNull();
    });
  });
});