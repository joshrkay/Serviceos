import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgCustomerGroupRepository } from '../../src/customers/pg-customer-group';
import {
  addCustomerToGroup,
  createCustomerGroup,
  removeCustomerFromGroup,
} from '../../src/customers/customer-group';
import type { Customer } from '../../src/customers/customer';
import { ConflictError } from '../../src/shared/errors';

describe('Postgres integration — customer groups (migration 227)', () => {
  let pool: Pool;
  let repo: PgCustomerGroupRepository;
  let customers: PgCustomerRepository;
  let tenant: { tenantId: string; userId: string };
  let c1: string;
  let c2: string;

  function baseCustomer(): Customer {
    const now = new Date();
    return {
      id: randomUUID(),
      tenantId: tenant.tenantId,
      firstName: 'Pat',
      lastName: 'Property',
      displayName: 'Pat Property',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
    };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCustomerGroupRepository(pool);
    customers = new PgCustomerRepository(pool);
    tenant = await createTestTenant(pool);
    c1 = (await customers.create(baseCustomer())).id;
    c2 = (await customers.create(baseCustomer())).id;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a group with real columns and member counts', async () => {
    const group = await createCustomerGroup(
      { tenantId: tenant.tenantId, name: 'Service plan members', color: '#3b82f6', createdBy: tenant.userId },
      repo,
    );

    const { rows } = await pool.query(
      `SELECT tenant_id, name, color, is_archived FROM customer_groups WHERE id = $1`,
      [group.id],
    );
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].name).toBe('Service plan members');
    expect(rows[0].color).toBe('#3b82f6');

    expect(await addCustomerToGroup(tenant.tenantId, group.id, c1, repo)).toBe(true);
    expect(await addCustomerToGroup(tenant.tenantId, group.id, c1, repo)).toBe(false); // idempotent
    await addCustomerToGroup(tenant.tenantId, group.id, c2, repo);

    const listed = await repo.listGroups(tenant.tenantId);
    expect(listed.find((g) => g.id === group.id)?.memberCount).toBe(2);

    expect((await repo.listMemberIds(tenant.tenantId, group.id)).sort()).toEqual([c1, c2].sort());
    expect((await repo.listGroupsForCustomer(tenant.tenantId, c1)).map((g) => g.id)).toContain(group.id);

    await removeCustomerFromGroup(tenant.tenantId, group.id, c1, repo);
    expect(await repo.listMemberIds(tenant.tenantId, group.id)).toEqual([c2]);
  });

  it('enforces unique group names per tenant (case-insensitive)', async () => {
    await createCustomerGroup(
      { tenantId: tenant.tenantId, name: 'Commercial', createdBy: tenant.userId },
      repo,
    );
    await expect(
      createCustomerGroup(
        { tenantId: tenant.tenantId, name: 'commercial', createdBy: tenant.userId },
        repo,
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('frees an archived group name for reuse (partial unique index, no 500)', async () => {
    const first = await createCustomerGroup(
      { tenantId: tenant.tenantId, name: 'Seasonal', createdBy: tenant.userId },
      repo,
    );
    await repo.archiveGroup(tenant.tenantId, first.id);
    // Recreating the same name must succeed now that the original is archived —
    // the partial unique index excludes archived rows, so no DB constraint 500.
    const second = await createCustomerGroup(
      { tenantId: tenant.tenantId, name: 'Seasonal', createdBy: tenant.userId },
      repo,
    );
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe('Seasonal');

    // With an archived row AND an active row sharing the name, findGroupByName
    // must prefer the active one so the duplicate check fires (rather than
    // returning the archived row and 500-ing on the partial unique index).
    const conflict = await repo.findGroupByName(tenant.tenantId, 'seasonal');
    expect(conflict?.id).toBe(second.id);
    expect(conflict?.isArchived).toBe(false);
    await expect(
      createCustomerGroup({ tenantId: tenant.tenantId, name: 'Seasonal', createdBy: tenant.userId }, repo),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('does not leak groups or membership across tenants (RLS)', async () => {
    const group = await createCustomerGroup(
      { tenantId: tenant.tenantId, name: 'Secret', createdBy: tenant.userId },
      repo,
    );
    await addCustomerToGroup(tenant.tenantId, group.id, c1, repo);
    const other = await createTestTenant(pool);
    expect(await repo.findGroupById(other.tenantId, group.id)).toBeNull();
    expect(await repo.listGroups(other.tenantId)).toEqual([]);
    expect(await repo.listMemberIds(other.tenantId, group.id)).toEqual([]);
  });
});
