/**
 * U4 — Docker-gated integration test for PgCustomerRepository.findByParentAccount.
 *
 * Pins the REAL column (`parent_account_id`, migration 178) and RLS so the
 * sub-account lookup can never ship against a mocked Pool with a nonexistent
 * column (the entity-resolver failure mode CLAUDE.md calls out).
 *
 * NOTE: Docker Hub pulls are rate-limited in this environment, so vitest's
 * integration globalSetup (test/integration/global-setup.ts) may fail to start
 * the testcontainer locally — that is EXPECTED. This file is authored to run in
 * PR CI where the container is available.
 */
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

describe('Postgres integration — findByParentAccount (U4)', () => {
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

  it('returns the direct sub-accounts of a parent, ordered by display_name', async () => {
    const parent = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        displayName: 'Acme Property Mgmt',
        accountType: 'property_manager',
      }),
    );
    const unitB = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        displayName: 'Acme — Unit B',
        accountType: 'b2b',
        parentAccountId: parent.id,
      }),
    );
    const unitA = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        displayName: 'Acme — Unit A',
        accountType: 'b2b',
        parentAccountId: parent.id,
      }),
    );

    const subs = await repo.findByParentAccount(tenant.tenantId, parent.id);
    expect(subs.map((s) => s.id).sort()).toEqual([unitA.id, unitB.id].sort());
    // Ordered by display_name ASC ("Unit A" before "Unit B").
    expect(subs[0].displayName).toBe('Acme — Unit A');
    expect(subs[1].displayName).toBe('Acme — Unit B');
    // The real column round-trips.
    expect(subs[0].parentAccountId).toBe(parent.id);
  });

  it('excludes archived sub-accounts', async () => {
    const parent = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        accountType: 'property_manager',
      }),
    );
    const active = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        displayName: 'Active unit',
        parentAccountId: parent.id,
      }),
    );
    const archived = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        displayName: 'Archived unit',
        parentAccountId: parent.id,
      }),
    );
    await repo.update(tenant.tenantId, archived.id, { isArchived: true });

    const subs = await repo.findByParentAccount(tenant.tenantId, parent.id);
    expect(subs.map((s) => s.id)).toEqual([active.id]);
  });

  it('returns [] for a parent with no sub-accounts', async () => {
    const lone = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        accountType: 'property_manager',
      }),
    );
    const subs = await repo.findByParentAccount(tenant.tenantId, lone.id);
    expect(subs).toEqual([]);
  });

  it('does not leak sub-accounts across tenants (RLS + tenant predicate)', async () => {
    const parent = await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        accountType: 'property_manager',
      }),
    );
    await repo.create(
      baseCustomer(tenant.tenantId, tenant.userId, {
        displayName: 'Tenant-A unit',
        parentAccountId: parent.id,
      }),
    );
    const otherTenant = await createTestTenant(pool);
    const leaked = await repo.findByParentAccount(otherTenant.tenantId, parent.id);
    expect(leaked).toEqual([]);
  });
});
