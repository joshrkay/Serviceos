/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Pins TenantGlossaryProvider against REAL Postgres-backed repositories
 * (PgCatalogItemRepository / PgCustomerRepository / real `users` rows), not
 * mocks — CLAUDE.md's "mocked-DB tests are never sufficient" rule: a mocked
 * repo would happily typecheck against nonexistent columns. This seeds real
 * catalog items, a customer, and a technician and asserts the glossary
 * provider surfaces their names from real columns, tenant-scoped and
 * excluding archived/other-tenant rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { createCatalogItem } from '../../src/catalog/catalog-item';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgUserRepository } from '../../src/users/pg-user';
import { TenantGlossaryProvider } from '../../src/voice/tenant-glossary-provider';

describe('Postgres integration — TenantGlossaryProvider', () => {
  let pool: Pool;
  let catalogRepo: PgCatalogItemRepository;
  let customerRepo: PgCustomerRepository;
  let userRepo: PgUserRepository;
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    catalogRepo = new PgCatalogItemRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    userRepo = new PgUserRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('collects real catalog item, customer, and technician names for the tenant', async () => {
    await catalogRepo.create(
      createCatalogItem({
        tenantId: tenant.tenantId,
        name: 'PEX Pipe 3/4in',
        description: 'PEX pipe',
        category: 'Materials',
        unit: 'each',
        unitPriceCents: 1200,
      })
    );

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Maria',
      lastName: 'Rodriguez',
      displayName: 'Maria Rodriguez',
      email: 'maria@example.com',
      primaryPhone: '+15555550100',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const technicianId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'technician', $5, $6)`,
      [technicianId, tenant.tenantId, technicianId, 'sam.lee@example.com', 'Sam', 'Lee']
    );

    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });
    const terms = await provider.termsForTenant(tenant.tenantId);

    expect(terms).toContain('PEX Pipe 3/4in');
    expect(terms).toContain('Maria Rodriguez');
    expect(terms).toContain('Sam Lee');
  });

  it('excludes archived catalog items, archived customers, and other tenants', async () => {
    const archivedItem = await catalogRepo.create(
      createCatalogItem({
        tenantId: tenant.tenantId,
        name: 'Archived Widget XYZ',
        description: 'no longer sold',
        category: 'Materials',
        unit: 'each',
        unitPriceCents: 500,
      })
    );
    await catalogRepo.archive(tenant.tenantId, archivedItem.id);

    const archivedCustomerId = crypto.randomUUID();
    await customerRepo.create({
      id: archivedCustomerId,
      tenantId: tenant.tenantId,
      firstName: 'Old',
      lastName: 'Customer',
      displayName: 'Old Archived Customer',
      email: 'old@example.com',
      primaryPhone: '+15555550101',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: true,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await catalogRepo.create(
      createCatalogItem({
        tenantId: other.tenantId,
        name: 'Other-Tenant-Only Item',
        description: 'belongs to a different tenant',
        category: 'Materials',
        unit: 'each',
        unitPriceCents: 500,
      })
    );

    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });
    const terms = await provider.termsForTenant(tenant.tenantId);

    expect(terms).not.toContain('Archived Widget XYZ');
    expect(terms).not.toContain('Old Archived Customer');
    expect(terms).not.toContain('Other-Tenant-Only Item');
  });
});
