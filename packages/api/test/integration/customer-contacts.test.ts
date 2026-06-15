import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgContactRepository } from '../../src/customers/pg-contact';
import type { Customer } from '../../src/customers/customer';
import type { CustomerContact } from '../../src/customers/contact';

function baseCustomer(tenantId: string, userId: string): Customer {
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
  };
}

function baseContact(
  tenantId: string,
  customerId: string,
  overrides: Partial<CustomerContact> = {}
): CustomerContact {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId,
    customerId,
    name: 'Contact Person',
    role: 'other',
    isPrimary: false,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Postgres integration — customer contacts (migration 186)', () => {
  let pool: Pool;
  let customers: PgCustomerRepository;
  let contacts: PgContactRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customers = new PgCustomerRepository(pool);
    contacts = new PgContactRepository(pool);
    tenant = await createTestTenant(pool);
    const customer = await customers.create(baseCustomer(tenant.tenantId, tenant.userId));
    customerId = customer.id;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a contact with all columns and reads it back', async () => {
    const created = await contacts.create(
      baseContact(tenant.tenantId, customerId, {
        name: 'Bill ToContact',
        role: 'billing',
        phone: '5551234567',
        email: 'bill@example.com',
        notes: 'Send invoices here',
      })
    );

    const found = await contacts.findById(tenant.tenantId, created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Bill ToContact');
    expect(found!.role).toBe('billing');
    expect(found!.phone).toBe('5551234567');
    expect(found!.email).toBe('bill@example.com');
    expect(found!.notes).toBe('Send invoices here');
    expect(found!.isPrimary).toBe(false);
  });

  it('enforces a single primary per customer in real SQL', async () => {
    const fresh = await customers.create(baseCustomer(tenant.tenantId, tenant.userId));
    const first = await contacts.create(
      baseContact(tenant.tenantId, fresh.id, { name: 'First', role: 'primary', isPrimary: true })
    );
    await contacts.create(
      baseContact(tenant.tenantId, fresh.id, { name: 'Second', role: 'primary', isPrimary: true })
    );

    const list = await contacts.findByCustomer(tenant.tenantId, fresh.id);
    expect(list.filter((c) => c.isPrimary)).toHaveLength(1);
    expect(list.filter((c) => c.isPrimary)[0].name).toBe('Second');

    const reloadedFirst = await contacts.findById(tenant.tenantId, first.id);
    expect(reloadedFirst!.isPrimary).toBe(false);
  });

  it('promotes via update and demotes the prior primary in the same transaction', async () => {
    const fresh = await customers.create(baseCustomer(tenant.tenantId, tenant.userId));
    const a = await contacts.create(
      baseContact(tenant.tenantId, fresh.id, { name: 'A', isPrimary: true })
    );
    const b = await contacts.create(baseContact(tenant.tenantId, fresh.id, { name: 'B' }));

    await contacts.update(tenant.tenantId, b.id, { isPrimary: true });

    expect((await contacts.findById(tenant.tenantId, a.id))!.isPrimary).toBe(false);
    expect((await contacts.findById(tenant.tenantId, b.id))!.isPrimary).toBe(true);
  });

  it('excludes archived contacts from the active list', async () => {
    const fresh = await customers.create(baseCustomer(tenant.tenantId, tenant.userId));
    const c = await contacts.create(baseContact(tenant.tenantId, fresh.id, { name: 'Gone' }));
    await contacts.update(tenant.tenantId, c.id, { isArchived: true, archivedAt: new Date() });

    const active = await contacts.findByCustomer(tenant.tenantId, fresh.id);
    expect(active.find((x) => x.id === c.id)).toBeUndefined();

    const all = await contacts.findByCustomer(tenant.tenantId, fresh.id, true);
    expect(all.find((x) => x.id === c.id)).toBeTruthy();
  });

  it('rejects a contact for a non-existent customer (FK)', async () => {
    await expect(
      contacts.create(baseContact(tenant.tenantId, crypto.randomUUID()))
    ).rejects.toThrow();
  });

  it('does not leak contacts across tenants (RLS)', async () => {
    const created = await contacts.create(baseContact(tenant.tenantId, customerId, { name: 'Secret' }));
    const other = await createTestTenant(pool);
    const leaked = await contacts.findById(other.tenantId, created.id);
    expect(leaked).toBeNull();
    const leakedList = await contacts.findByCustomer(other.tenantId, customerId);
    expect(leakedList).toHaveLength(0);
  });
});
