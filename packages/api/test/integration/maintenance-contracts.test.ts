/**
 * Postgres integration — maintenance contracts persist to a real, tenant-scoped
 * table (migration 203). Proves the graduated PgMaintenanceContractRepository
 * round-trips the row (pins the real columns) and isolates tenants.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgMaintenanceContractRepository } from '../../src/maintenance-contracts/pg-maintenance-contract';
import type { MaintenanceContract } from '../../src/maintenance-contracts/maintenance-contract';

function contract(tenantId: string): MaintenanceContract {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId,
    title: 'Quarterly HVAC',
    status: 'active',
    customer: { displayName: 'Acme Co' },
    location: { street1: '123 Main St' },
    cadence: 'quarterly',
    serviceWindow: 'morning',
    duration: '12 months',
    startDate: '2026-07-01',
    defaultSummary: 'Filter + coil check',
    createdAt: now,
    updatedAt: now,
  };
}

describe('Postgres integration — maintenance contracts', () => {
  let pool: Pool;
  let repo: PgMaintenanceContractRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgMaintenanceContractRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('creates and reads back a contract (pins the real columns)', async () => {
    const created = await repo.create(contract(tenant.tenantId));

    const found = await repo.findById(tenant.tenantId, created.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Quarterly HVAC');
    expect(found!.status).toBe('active');
    expect(found!.customer).toEqual({ displayName: 'Acme Co' });
    expect(found!.location).toEqual({ street1: '123 Main St' });
    expect(found!.cadence).toBe('quarterly');
    expect(found!.startDate).toBe('2026-07-01');

    const list = await repo.findByTenant(tenant.tenantId);
    expect(list.some((c) => c.id === created.id)).toBe(true);
  });

  it('does not leak a contract across tenants', async () => {
    const other = await createTestTenant(pool);
    const created = await repo.create(contract(tenant.tenantId));
    const fromOther = await repo.findById(other.tenantId, created.id);
    expect(fromOther).toBeNull();
    const otherList = await repo.findByTenant(other.tenantId);
    expect(otherList.some((c) => c.id === created.id)).toBe(false);
  });
});
