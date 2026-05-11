import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';

describe('Postgres integration — customers', () => {
  let pool: Pool;
  let repo: PgCustomerRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCustomerRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates customer and retrieves via findById', async () => {
      const customer = await repo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        firstName: 'John',
        lastName: 'Doe',
        displayName: 'John Doe',
        email: 'john@example.com',
        primaryPhone: '555-1234',
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await repo.findById(tenant.tenantId, customer.id);
      expect(found).not.toBeNull();
      expect(found!.firstName).toBe('John');
      expect(found!.lastName).toBe('Doe');
      expect(found!.email).toBe('john@example.com');
    });

    it('updates customer and reflects in findById', async () => {
      const customer = await repo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        firstName: 'Jane',
        lastName: 'Smith',
        displayName: 'Jane Smith',
        email: 'jane@example.com',
        preferredChannel: 'email',
        smsConsent: false,
        isArchived: false,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await repo.update(tenant.tenantId, customer.id, {
        firstName: 'Jane Updated',
      });

      expect(updated).not.toBeNull();
      expect(updated!.firstName).toBe('Jane Updated');

      const found = await repo.findById(tenant.tenantId, customer.id);
      expect(found!.firstName).toBe('Jane Updated');
    });

    it('finds customers by tenant', async () => {
      await repo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        firstName: 'Alice',
        lastName: 'Wonder',
        displayName: 'Alice Wonder',
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const customers = await repo.findByTenant(tenant.tenantId);
      expect(customers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const customer = await repo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        firstName: 'Secret',
        lastName: 'Customer',
        displayName: 'Secret Customer',
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await repo.findById(otherTenant.tenantId, customer.id);
      expect(found).toBeNull();
    });
  });
});