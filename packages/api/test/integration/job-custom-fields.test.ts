import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobCustomFieldRepository } from '../../src/jobs/pg-job-custom-field';
import {
  createJobCustomFieldDef,
  setJobCustomFieldValue,
  listResolvedJobCustomFields,
} from '../../src/jobs/job-custom-field';
import type { Job } from '../../src/jobs/job';

async function seedJob(pool: Pool, tenantId: string, userId: string): Promise<string> {
  const customers = new PgCustomerRepository(pool);
  const locations = new PgLocationRepository(pool);
  const jobs = new PgJobRepository(pool);
  const customerId = crypto.randomUUID();
  await customers.create({
    id: customerId,
    tenantId,
    firstName: 'CF',
    lastName: 'Customer',
    displayName: 'CF Customer',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const locationId = crypto.randomUUID();
  await locations.create({
    id: locationId,
    tenantId,
    customerId,
    street1: '9 Birch',
    city: 'Akron',
    state: 'OH',
    postalCode: '44301',
    country: 'USA',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const job: Job = {
    id: crypto.randomUUID(),
    tenantId,
    customerId,
    locationId,
    jobNumber: `JOB-${Math.floor(Math.random() * 1_000_000)}`,
    summary: 'CF job',
    status: 'new',
    priority: 'normal',
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return (await jobs.create(job)).id;
}

describe('Postgres integration — job custom fields (migration 224)', () => {
  let pool: Pool;
  let repo: PgJobCustomFieldRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgJobCustomFieldRepository(pool);
    tenant = await createTestTenant(pool);
    jobId = await seedJob(pool, tenant.tenantId, tenant.userId);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a typed def + value and upserts in place', async () => {
    const def = await createJobCustomFieldDef(
      {
        tenantId: tenant.tenantId,
        key: 'permit_no',
        label: 'Permit #',
        createdBy: tenant.userId,
      },
      repo
    );
    const { rows } = await pool.query(
      `SELECT tenant_id, key, label, field_type, is_archived
         FROM job_custom_field_defs WHERE id = $1`,
      [def.id]
    );
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].key).toBe('permit_no');
    expect(rows[0].field_type).toBe('text');

    await setJobCustomFieldValue(tenant.tenantId, jobId, def.id, 'P-123', repo);
    let resolved = await listResolvedJobCustomFields(tenant.tenantId, jobId, repo);
    expect(resolved.find((r) => r.key === 'permit_no')?.value).toBe('P-123');

    // Upsert in place.
    await setJobCustomFieldValue(tenant.tenantId, jobId, def.id, 'P-456', repo);
    resolved = await listResolvedJobCustomFields(tenant.tenantId, jobId, repo);
    expect(resolved.find((r) => r.key === 'permit_no')?.value).toBe('P-456');

    // Clearing deletes the value row.
    await setJobCustomFieldValue(tenant.tenantId, jobId, def.id, null, repo);
    resolved = await listResolvedJobCustomFields(tenant.tenantId, jobId, repo);
    expect(resolved.find((r) => r.key === 'permit_no')?.value).toBeNull();
  });

  it('rejects a duplicate key (unique constraint)', async () => {
    await createJobCustomFieldDef(
      { tenantId: tenant.tenantId, key: 'dup', label: 'Dup', createdBy: tenant.userId },
      repo
    );
    await expect(
      createJobCustomFieldDef(
        { tenantId: tenant.tenantId, key: 'dup', label: 'Dup2', createdBy: tenant.userId },
        repo
      )
    ).rejects.toThrow(/already exists/);
  });

  it('does not leak defs across tenants (RLS)', async () => {
    await createJobCustomFieldDef(
      { tenantId: tenant.tenantId, key: 'secret', label: 'Secret', createdBy: tenant.userId },
      repo
    );
    const other = await createTestTenant(pool);
    expect(await repo.listDefs(other.tenantId)).toEqual([]);
  });
});
