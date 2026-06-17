import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgTagRepository } from '../../src/customers/pg-tag';
import { PgCustomFieldRepository } from '../../src/customers/pg-custom-field';
import {
  createCustomFieldDef,
  setCustomFieldValue,
  listResolvedCustomFields,
} from '../../src/customers/custom-field';
import type { Customer } from '../../src/customers/customer';

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

describe('Postgres integration — customer tags + custom fields (migration 187)', () => {
  let pool: Pool;
  let customers: PgCustomerRepository;
  let tags: PgTagRepository;
  let fields: PgCustomFieldRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customers = new PgCustomerRepository(pool);
    tags = new PgTagRepository(pool);
    fields = new PgCustomFieldRepository(pool);
    tenant = await createTestTenant(pool);
    customerId = (await customers.create(baseCustomer(tenant.tenantId, tenant.userId))).id;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('adds tags idempotently and lists customers by tag', async () => {
    const fresh = (await customers.create(baseCustomer(tenant.tenantId, tenant.userId))).id;
    expect(await tags.addTag(tenant.tenantId, fresh, 'vip')).toBe(true);
    expect(await tags.addTag(tenant.tenantId, fresh, 'vip')).toBe(false); // idempotent
    await tags.addTag(tenant.tenantId, fresh, 'net 30');

    expect(await tags.listForCustomer(tenant.tenantId, fresh)).toEqual(['net 30', 'vip']);
    expect(await tags.listCustomerIdsByTag(tenant.tenantId, 'vip')).toContain(fresh);

    await tags.removeTag(tenant.tenantId, fresh, 'vip');
    expect(await tags.listForCustomer(tenant.tenantId, fresh)).toEqual(['net 30']);
  });

  it('persists a typed custom-field def + value and upserts in place', async () => {
    const def = await createCustomFieldDef(
      {
        tenantId: tenant.tenantId,
        key: 'membership',
        label: 'Membership',
        fieldType: 'select',
        options: ['gold', 'silver'],
        createdBy: tenant.userId,
      },
      fields
    );

    await setCustomFieldValue(tenant.tenantId, customerId, def.id, 'gold', fields);
    let resolved = await listResolvedCustomFields(tenant.tenantId, customerId, fields);
    expect(resolved.find((r) => r.key === 'membership')?.value).toBe('gold');

    // Upsert: setting again updates the same row (unique constraint holds).
    await setCustomFieldValue(tenant.tenantId, customerId, def.id, 'silver', fields);
    resolved = await listResolvedCustomFields(tenant.tenantId, customerId, fields);
    expect(resolved.find((r) => r.key === 'membership')?.value).toBe('silver');

    // Clearing deletes the value row.
    await setCustomFieldValue(tenant.tenantId, customerId, def.id, null, fields);
    resolved = await listResolvedCustomFields(tenant.tenantId, customerId, fields);
    expect(resolved.find((r) => r.key === 'membership')?.value).toBeNull();
  });

  it('rejects a duplicate field key (unique constraint)', async () => {
    await createCustomFieldDef(
      { tenantId: tenant.tenantId, key: 'dup_key', label: 'Dup', createdBy: tenant.userId },
      fields
    );
    await expect(
      createCustomFieldDef(
        { tenantId: tenant.tenantId, key: 'dup_key', label: 'Dup2', createdBy: tenant.userId },
        fields
      )
    ).rejects.toThrow(/already exists/);
  });

  it('archived defs drop out of the resolved active list', async () => {
    const def = await createCustomFieldDef(
      { tenantId: tenant.tenantId, key: 'temp_field', label: 'Temp', createdBy: tenant.userId },
      fields
    );
    await fields.archiveDef(tenant.tenantId, def.id);
    const resolved = await listResolvedCustomFields(tenant.tenantId, customerId, fields);
    expect(resolved.find((r) => r.key === 'temp_field')).toBeUndefined();
  });

  it('does not leak tags or custom fields across tenants (RLS)', async () => {
    await tags.addTag(tenant.tenantId, customerId, 'secret-tag');
    const other = await createTestTenant(pool);
    expect(await tags.listForCustomer(other.tenantId, customerId)).toEqual([]);
    expect(await tags.listDistinctTags(other.tenantId)).toEqual([]);
    expect(await fields.listDefs(other.tenantId)).toEqual([]);
  });
});
