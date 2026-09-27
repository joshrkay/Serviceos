/**
 * #1406 D3 — the job-detail Parts sheet persists through material_items.
 *
 * Before: MaterialsSheet's Save only set React state — no API call, and
 * material_items had 0 rows after a QA session. This pins the real SQL
 * behind `saveJobMaterials` / `listJobMaterials` (PgMaterialItemRepository +
 * PgAuditRepository) against a real database.
 *
 * Seam: `saveJobMaterials` / `listJobMaterials` (materials/job-materials).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgMaterialItemRepository } from '../../src/materials/pg-material-item';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { listJobMaterials, saveJobMaterials } from '../../src/materials/job-materials';

async function createJob(pool: Pool, tenant: TestTenant): Promise<string> {
  const customerId = randomUUID();
  const locationId = randomUUID();
  const jobId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
    await client.query(
      `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
      [customerId, tenant.tenantId, 'Test Customer', tenant.userId],
    );
    await client.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [locationId, tenant.tenantId, customerId, '1 Main St', 'Austin', 'TX', '78701'],
    );
    await client.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [jobId, tenant.tenantId, customerId, locationId, `JOB-${jobId.slice(0, 8)}`, 'Test job', tenant.userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return jobId;
}

describe('Postgres integration — job materials (#1406 D3)', () => {
  let pool: Pool;
  let deps: { materialItemRepo: PgMaterialItemRepository; auditRepo: PgAuditRepository };
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    deps = {
      materialItemRepo: new PgMaterialItemRepository(pool),
      auditRepo: new PgAuditRepository(pool),
    };
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a saved parts list reads back with quantity, unit cost (cents), part number and category', async () => {
    const jobId = await createJob(pool, tenant);
    const actor = { tenantId: tenant.tenantId, actorId: tenant.userId, actorRole: 'owner' };

    await saveJobMaterials(
      actor,
      jobId,
      [
        { name: '45/5 MFD Dual Run Capacitor', partNumber: 'CAP-45-5-440V', quantity: 2, unitCostCents: 2850, category: 'Part' },
        { name: 'Service Labor (hour)', quantity: 1, unitCostCents: 9500, category: 'Labor' },
      ],
      deps,
    );

    const listed = await listJobMaterials(tenant.tenantId, jobId, deps);
    expect(
      listed.map((m) => ({
        name: m.description,
        partNumber: m.partNumber,
        quantity: m.quantity,
        unitCostCents: m.unitCostCents,
        category: m.category,
      })),
    ).toEqual([
      { name: '45/5 MFD Dual Run Capacitor', partNumber: 'CAP-45-5-440V', quantity: 2, unitCostCents: 2850, category: 'Part' },
      { name: 'Service Labor (hour)', partNumber: undefined, quantity: 1, unitCostCents: 9500, category: 'Labor' },
    ]);
  });

  it('re-saving the sheet updates kept rows, drops removed ones, and adds new ones', async () => {
    const jobId = await createJob(pool, tenant);
    const actor = { tenantId: tenant.tenantId, actorId: tenant.userId, actorRole: 'owner' };
    const first = await saveJobMaterials(
      actor,
      jobId,
      [
        { name: 'Wax Ring w/ Bolts', quantity: 1, unitCostCents: 750, category: 'Part' },
        { name: 'P-Trap 1.5" ABS', quantity: 1, unitCostCents: 625, category: 'Part' },
      ],
      deps,
    );
    const waxRing = first.find((m) => m.description === 'Wax Ring w/ Bolts')!;

    await saveJobMaterials(
      actor,
      jobId,
      [
        { id: waxRing.id, name: 'Wax Ring w/ Bolts', quantity: 3, unitCostCents: 750, category: 'Part' },
        { id: 'm-1727400000000', name: 'Toilet Flapper Valve', quantity: 2, unitCostCents: 550, category: 'Part' },
      ],
      deps,
    );

    const listed = await listJobMaterials(tenant.tenantId, jobId, deps);
    expect(listed.map((m) => [m.description, m.quantity])).toEqual([
      ['Wax Ring w/ Bolts', 3],
      ['Toilet Flapper Valve', 2],
    ]);
    expect(listed[0].id).toBe(waxRing.id);
  });
});
