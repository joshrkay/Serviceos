import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgInvoiceScheduleRepository } from '../../src/invoices/pg-invoice-schedule';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { createInvoiceWithNextNumber } from '../../src/invoices/invoice';
import { buildInvoiceSchedule, MILESTONE_UNIQUE_INDEX } from '../../src/invoices/invoice-schedule';
import { mintCompletionMilestones } from '../../src/invoices/schedule-completion';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { Job } from '../../src/jobs/job';

/**
 * Pins the real Postgres indexes behind milestone billing. Before the fix, a
 * 50% deposit / 50% balance schedule that referenced an estimate billed ONLY
 * the deposit: the balance INSERT tripped uq_invoices_estimate and the
 * completion hook swallowed every 23505 as "already minted". In-memory repos
 * never raise the index, so only this test proves the balance is billed.
 */
describe('Postgres integration — milestone billing against an estimate', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let scheduleRepo: PgInvoiceScheduleRepository;
  let settingsRepo: PgSettingsRepository;
  let tenant: { tenantId: string; userId: string };
  let job: Job;
  let estimateId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    scheduleRepo = new PgInvoiceScheduleRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    const estimateRepo = new PgEstimateRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Milestone Co',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Opt-in kill switch (migration 26x): create() does not persist it, update() does.
    await settingsRepo.update(tenant.tenantId, { milestoneBillingEnabled: true });

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Mila',
      lastName: 'Stone',
      displayName: 'Mila Stone',
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
      street1: '1 Deposit Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    job = await jobRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-MS-1',
      summary: 'Roof replacement',
      status: 'completed',
      priority: 'normal',
      depositRequiredCents: 0,
      depositPaidCents: 0,
      depositStatus: 'not_required',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const items = [buildLineItem(crypto.randomUUID(), 'Roof', 1, 100000, 0, true, 'labor')];
    estimateId = crypto.randomUUID();
    await estimateRepo.create({
      id: estimateId,
      tenantId: tenant.tenantId,
      jobId: job.id,
      estimateNumber: 'EST-MS-1',
      status: 'accepted',
      lineItems: items,
      totals: calculateDocumentTotals(items, 0, 0),
      version: 1,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('both unique indexes the mint paths reason about exist with the expected names', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'invoices' AND indexname = ANY($1)`,
      [['uq_invoices_estimate', MILESTONE_UNIQUE_INDEX]],
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual(['uq_invoices_estimate', MILESTONE_UNIQUE_INDEX].sort());
  });

  it('bills the on_completion balance when the deposit already links the estimate', async () => {
    const schedule = buildInvoiceSchedule({
      tenantId: tenant.tenantId,
      jobId: job.id,
      estimateId,
      totalAmountCents: 100000,
      milestones: [
        { label: 'Deposit', type: 'percent', value: 5000, trigger: 'on_accept' },
        { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
      ],
      createdBy: tenant.userId,
    });
    await scheduleRepo.create(schedule);

    // The deposit minted at schedule approval carries the estimate link.
    const deposit = await createInvoiceWithNextNumber(
      {
        tenantId: tenant.tenantId,
        jobId: job.id,
        estimateId,
        lineItems: [buildLineItem(crypto.randomUUID(), 'Deposit', 1, 50000, 0, true)],
        createdBy: tenant.userId,
        scheduleId: schedule.id,
        milestoneIndex: 0,
      },
      invoiceRepo,
      settingsRepo,
    );
    expect(deposit.estimateId).toBe(estimateId);

    const created = await mintCompletionMilestones({ scheduleRepo, invoiceRepo, settingsRepo }, job);
    expect(created).toHaveLength(1);
    expect(created[0].scheduleId).toBe(schedule.id);
    expect(created[0].milestoneIndex).toBe(1);
    expect(created[0].totals.totalCents).toBe(50000);
    expect(created[0].estimateId).toBeUndefined();

    const { rows } = await pool.query<{ milestone_index: number; estimate_id: string | null; total_cents: number }>(
      `SELECT milestone_index, estimate_id, total_cents FROM invoices
        WHERE tenant_id = $1 AND schedule_id = $2 ORDER BY milestone_index`,
      [tenant.tenantId, schedule.id],
    );
    expect(rows).toEqual([
      { milestone_index: 0, estimate_id: estimateId, total_cents: 50000 },
      { milestone_index: 1, estimate_id: null, total_cents: 50000 },
    ]);

    // Re-running completion mints nothing further (idempotent on the real index).
    const again = await mintCompletionMilestones({ scheduleRepo, invoiceRepo, settingsRepo }, job);
    expect(again).toHaveLength(0);
  });
});
