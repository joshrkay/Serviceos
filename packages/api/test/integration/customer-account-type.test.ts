import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import type { Customer } from '../../src/customers/customer';

function baseCustomer(
  tenantId: string,
  userId: string,
  overrides: Partial<Customer> = {},
): Customer {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId,
    firstName: 'Pat',
    lastName: 'Property',
    displayName: 'Pat Property',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Postgres integration — customer B2B hierarchy (migration 178)', () => {
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

  it('persists property_manager account_type and a parent_account_id sub-account', async () => {
    const parent = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { accountType: 'property_manager' }),
    );
    const child = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        accountType: 'b2b',
        parentAccountId: parent.id,
      }),
    );

    const found = await repo.findById(tenant.tenantId, child.id);
    expect(found).not.toBeNull();
    expect(found!.accountType).toBe('b2b');
    expect(found!.parentAccountId).toBe(parent.id);

    const foundParent = await repo.findById(tenant.tenantId, parent.id);
    expect(foundParent!.accountType).toBe('property_manager');
    expect(foundParent!.parentAccountId).toBeUndefined();
  });

  it('rejects a self-referential parent', async () => {
    const c = await repo.create(baseCustomer(tenant.tenantId, tenant.userId));
    await expect(
      repo.update(tenant.tenantId, c.id, { parentAccountId: c.id }),
    ).rejects.toThrow(/own parent/i);
  });

  it('rejects a hierarchy cycle (A -> B -> A)', async () => {
    const parent = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { accountType: 'property_manager' }),
    );
    const child = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { parentAccountId: parent.id }),
    );
    await expect(
      repo.update(tenant.tenantId, parent.id, { parentAccountId: child.id }),
    ).rejects.toThrow(/cycle/i);
  });

  it('rejects a dangling parent reference', async () => {
    await expect(
      repo.create(
        baseCustomer(tenant.tenantId, tenant.userId, { parentAccountId: crypto.randomUUID() }),
      ),
    ).rejects.toThrow(/does not exist/i);
  });

  it('does not leak a sub-account across tenants (RLS)', async () => {
    const parent = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { accountType: 'property_manager' }),
    );
    const child = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, { parentAccountId: parent.id }),
    );
    const otherTenant = await createTestTenant(pool);
    const leaked = await repo.findById(otherTenant.tenantId, child.id);
    expect(leaked).toBeNull();
  });
});
