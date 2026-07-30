/**
 * B7.5 (rivet-voice-19) — a spoken part keeps its unit all the way to the row.
 *
 * "Add three 45-microfarad capacitors to the Smith estimate" has to survive a
 * long chain: proposal payload → edit action → billing line → INSERT → row
 * mapper → domain object. A field that vanishes on round-trip is exactly the
 * defect class this run exists to kill, and `unit` had six places to disappear.
 *
 * The other half of this test is the invariant that makes `unit` safe to add
 * at all: it is DESCRIPTIVE. Totals must be byte-identical to the same line
 * without a unit, because nothing in the billing engine reads it.
 *
 * Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createEstimate, updateEstimate } from '../../src/estimates/estimate';
import { getNextEstimateNumber } from '../../src/settings/settings';
import { applyEstimateEdits, EstimateEditAction } from '../../src/estimates/estimate-editor';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — B7.5 spoken part keeps its unit through persistence', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let estimateId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    tenant = await createTestTenant(pool);

    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const settingsRepo = new PgSettingsRepository(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Dana',
      lastName: 'Smith',
      displayName: 'Dana Smith',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '7 Smith Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-SMITH-PARTS',
      summary: 'Smith — AC service',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const estimate = await createEstimate(
      {
        tenantId: tenant.tenantId,
        jobId,
        estimateNumber: await getNextEstimateNumber(tenant.tenantId, settingsRepo),
        lineItems: [buildLineItem('li-seed', 'Diagnostic', 1, 9900, 0, true, 'labor')],
        createdBy: tenant.userId,
      },
      estimateRepo,
      auditRepo,
    );
    estimateId = estimate.id;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists description, quantity, unit and integer-cents price, and reads them all back', async () => {
    const estimate = await estimateRepo.findById(tenant.tenantId, estimateId);
    expect(estimate).not.toBeNull();

    // The shape the voice edit path produces for the spoken sentence.
    const actions: EstimateEditAction[] = [
      {
        type: 'add_line_item',
        lineItem: {
          description: '45-microfarad capacitor',
          quantity: 3,
          unit: 'each',
          unitPrice: 4250,
          category: 'material',
        },
      },
    ];

    const { updatedEstimate } = applyEstimateEdits(estimate!, actions);
    await updateEstimate(
      tenant.tenantId,
      estimateId,
      { lineItems: updatedEstimate.lineItems },
      estimateRepo,
      { auditRepo, actorId: tenant.userId, actorRole: 'system' },
    );

    // Read back through the repo (row mapper), not the in-memory object.
    const reloaded = await estimateRepo.findById(tenant.tenantId, estimateId);
    const line = reloaded!.lineItems.find((l) => l.description === '45-microfarad capacitor');
    expect(line).toBeDefined();
    expect(line!.quantity).toBe(3);
    expect(line!.unit).toBe('each');
    expect(line!.unitPriceCents).toBe(4250);
    expect(line!.totalCents).toBe(12750);

    // And the column really holds it — not just the mapper inventing a default.
    const { rows } = await pool.query(
      `SELECT unit FROM estimate_line_items WHERE estimate_id = $1 AND description = $2`,
      [estimateId, '45-microfarad capacitor'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].unit).toBe('each');
  });

  it('a unit never changes the money: totals match the same line without one', () => {
    const withUnit = {
      ...buildLineItem('a', 'labor', 2, 9000, 0, true, 'labor'),
      unit: 'hour' as const,
    };
    const withoutUnit = buildLineItem('b', 'labor', 2, 9000, 0, true, 'labor');

    expect(withUnit.totalCents).toBe(withoutUnit.totalCents);
    expect(calculateDocumentTotals([withUnit], 0, 0)).toEqual(
      calculateDocumentTotals([withoutUnit], 0, 0),
    );
  });

  it('does not expose the line to another tenant (scoped read)', async () => {
    const other = await createTestTenant(pool);
    expect(await estimateRepo.findById(other.tenantId, estimateId)).toBeNull();
  });
});
