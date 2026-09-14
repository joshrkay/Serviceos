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
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createInvoiceWithNextNumber } from '../../src/invoices/invoice';
import {
  buildInvoiceSchedule,
  InvoiceMilestone,
  MILESTONE_UNIQUE_INDEX,
} from '../../src/invoices/invoice-schedule';
import { mintCompletionMilestones } from '../../src/invoices/schedule-completion';
import { convertEstimateToInvoice } from '../../src/invoices/convert-estimate';
import { CreateInvoiceScheduleExecutionHandler } from '../../src/proposals/execution/invoice-schedule-handler';
import { Proposal } from '../../src/proposals/proposal';
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

  /**
   * #1203 — an estimate that was already invoiced (POST /estimates/:id/
   * convert-to-invoice) must never get a milestone plan minted on top of that
   * invoice. #975 made milestoneEstimateLink treat ANY invoice carrying the
   * estimate id as "the first milestone holds the link", so both mint paths
   * drafted every milestone without the link: $1,000 converted + $500 deposit
   * + $500 balance = $2,000 of drafts for a $1,000 estimate. Before #975 the
   * uq_invoices_estimate collision blocked it by accident.
   *
   * "Belongs to this schedule" is decided by the schedule linkage
   * (invoices.schedule_id), never by estimate_id alone: the schedule's own
   * deposit carries the estimate id and must keep billing its balance.
   */
  describe('#1203 — never mint milestones over an estimate that was already invoiced', () => {
    let estimateRepo: PgEstimateRepository;
    let jobRepo: PgJobRepository;
    let customerRepo: PgCustomerRepository;
    let locationRepo: PgLocationRepository;
    let auditRepo: PgAuditRepository;
    let handler: CreateInvoiceScheduleExecutionHandler;

    const DEPOSIT_THEN_BALANCE: InvoiceMilestone[] = [
      { label: 'Deposit', type: 'percent', value: 5000, trigger: 'on_accept' },
      { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
    ];
    // Nothing is minted at approval: both halves bill when the job completes.
    const BOTH_ON_COMPLETION: InvoiceMilestone[] = [
      { label: 'Rough-in', type: 'percent', value: 5000, trigger: 'on_completion' },
      { label: 'Final', type: 'remainder', value: 0, trigger: 'on_completion' },
    ];

    interface Seeded {
      tenantId: string;
      userId: string;
      job: Job;
      estimateId: string;
    }

    interface InvoiceRow {
      invoice_number: string;
      estimate_id: string | null;
      schedule_id: string | null;
      milestone_index: number | null;
      total_cents: number;
    }

    /** A fresh tenant with milestone billing on, a job, and an ACCEPTED estimate. */
    async function seedAcceptedEstimate(tag: string, amountCents: number): Promise<Seeded> {
      const { tenantId, userId } = await createTestTenant(pool);
      const now = new Date();
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId,
        businessName: `Milestone ${tag}`,
        timezone: 'UTC',
        estimatePrefix: 'EST-',
        invoicePrefix: 'INV-',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: now,
        updatedAt: now,
      });
      await settingsRepo.update(tenantId, { milestoneBillingEnabled: true });

      const customerId = crypto.randomUUID();
      await customerRepo.create({
        id: customerId,
        tenantId,
        firstName: 'Dee',
        lastName: tag,
        displayName: `Dee ${tag}`,
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      const locationId = crypto.randomUUID();
      await locationRepo.create({
        id: locationId,
        tenantId,
        customerId,
        street1: '1203 Double Bill Ln',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        country: 'USA',
        addressType: 'service',
        isPrimary: true,
        isArchived: false,
        createdAt: now,
        updatedAt: now,
      });
      const job = await jobRepo.create({
        id: crypto.randomUUID(),
        tenantId,
        customerId,
        locationId,
        jobNumber: `JOB-1203-${tag}`,
        summary: 'Water heater swap',
        status: 'completed',
        priority: 'normal',
        depositRequiredCents: 0,
        depositPaidCents: 0,
        depositStatus: 'not_required',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });

      const items = [buildLineItem(crypto.randomUUID(), 'Water heater', 1, amountCents, 0, true, 'labor')];
      const estimateId = crypto.randomUUID();
      await estimateRepo.create({
        id: estimateId,
        tenantId,
        jobId: job.id,
        estimateNumber: `EST-1203-${tag}`,
        status: 'accepted',
        lineItems: items,
        totals: calculateDocumentTotals(items, 0, 0),
        version: 1,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      return { tenantId, userId, job, estimateId };
    }

    /** The conversion POST /estimates/:id/convert-to-invoice runs. */
    async function convert(s: Seeded) {
      const invoice = await convertEstimateToInvoice(s.tenantId, s.estimateId, {
        estimateRepo,
        invoiceRepo,
        jobRepo,
        settingsRepo,
        auditRepo,
        actorId: s.userId,
      });
      expect(invoice).not.toBeNull();
      return invoice!;
    }

    /** An owner-approved create_invoice_schedule proposal; the total derives from the estimate. */
    function approvedSchedule(s: Seeded, milestones: InvoiceMilestone[]): Proposal {
      return {
        id: crypto.randomUUID(),
        tenantId: s.tenantId,
        proposalType: 'create_invoice_schedule',
        status: 'approved',
        payload: { jobId: s.job.id, estimateId: s.estimateId, milestones },
        summary: 'Bill in stages',
        createdBy: s.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    function completeJob(s: Seeded) {
      return mintCompletionMilestones({ scheduleRepo, invoiceRepo, settingsRepo, auditRepo }, s.job);
    }

    /** Every invoice on the job, straight out of Postgres. */
    async function invoiceRows(s: Seeded): Promise<InvoiceRow[]> {
      const { rows } = await pool.query<InvoiceRow>(
        `SELECT invoice_number, estimate_id, schedule_id, milestone_index, total_cents::int AS total_cents
           FROM invoices WHERE tenant_id = $1 AND job_id = $2 ORDER BY invoice_number`,
        [s.tenantId, s.job.id],
      );
      return rows;
    }

    const convertedRow = (s: Seeded, invoiceNumber: string): InvoiceRow => ({
      invoice_number: invoiceNumber,
      estimate_id: s.estimateId,
      schedule_id: null,
      milestone_index: null,
      total_cents: 100000,
    });

    beforeAll(() => {
      estimateRepo = new PgEstimateRepository(pool);
      jobRepo = new PgJobRepository(pool);
      customerRepo = new PgCustomerRepository(pool);
      locationRepo = new PgLocationRepository(pool);
      auditRepo = new PgAuditRepository(pool);
      handler = new CreateInvoiceScheduleExecutionHandler(scheduleRepo, invoiceRepo, settingsRepo, estimateRepo);
    });

    it('refuses to create a schedule for a converted estimate: no schedule row, no invoice beyond the converted one', async () => {
      const s = await seedAcceptedEstimate('A-CONVERTED', 100000);
      const converted = await convert(s);
      expect(converted.estimateId).toBe(s.estimateId);
      expect(converted.totals.totalCents).toBe(100000);

      const result = await handler.execute(approvedSchedule(s, DEPOSIT_THEN_BALANCE), {
        tenantId: s.tenantId,
        executedBy: s.userId,
      });
      await completeJob(s);

      // Only the converted $1,000 invoice: no $500 deposit + $500 balance on top.
      expect(await invoiceRows(s)).toEqual([convertedRow(s, converted.invoiceNumber)]);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already invoiced/i);
      expect(result.error).toContain(converted.invoiceNumber);
      expect(await scheduleRepo.findByJob(s.tenantId, s.job.id)).toEqual([]);
    });

    it('a schedule approved BEFORE the conversion refuses to mint over the converted invoice at completion', async () => {
      const s = await seedAcceptedEstimate('B-SCHEDULED-FIRST', 100000);
      const approved = await handler.execute(approvedSchedule(s, BOTH_ON_COMPLETION), {
        tenantId: s.tenantId,
        executedBy: s.userId,
      });
      expect(approved.success).toBe(true);
      expect(await invoiceRows(s)).toEqual([]);

      const converted = await convert(s);
      const outcome = await completeJob(s).then(
        (created) => ({ created, error: undefined as Error | undefined }),
        (error: Error) => ({ created: undefined, error }),
      );

      expect(await invoiceRows(s)).toEqual([convertedRow(s, converted.invoiceNumber)]);
      expect(outcome.created).toBeUndefined();
      expect(outcome.error?.message).toMatch(/already invoiced/i);
    });

    it('a legacy schedule whose deposit was minted beside the converted invoice does not mint its balance', async () => {
      // The row shape origin/main could already have written: a converted
      // invoice plus a schedule whose deposit went out without the link.
      const s = await seedAcceptedEstimate('C-LEGACY', 100000);
      const converted = await convert(s);
      const schedule = buildInvoiceSchedule({
        tenantId: s.tenantId,
        jobId: s.job.id,
        estimateId: s.estimateId,
        totalAmountCents: 100000,
        milestones: DEPOSIT_THEN_BALANCE,
        createdBy: s.userId,
      });
      await scheduleRepo.create(schedule);
      const legacyDeposit = await createInvoiceWithNextNumber(
        {
          tenantId: s.tenantId,
          jobId: s.job.id,
          lineItems: [buildLineItem(crypto.randomUUID(), 'Deposit', 1, 50000, 0, true)],
          createdBy: s.userId,
          scheduleId: schedule.id,
          milestoneIndex: 0,
        },
        invoiceRepo,
        settingsRepo,
      );

      await expect(completeJob(s)).rejects.toThrow(/already invoiced/i);

      expect(await invoiceRows(s)).toEqual([
        convertedRow(s, converted.invoiceNumber),
        {
          invoice_number: legacyDeposit.invoiceNumber,
          estimate_id: null,
          schedule_id: schedule.id,
          milestone_index: 0,
          total_cents: 50000,
        },
      ]);
    });

    it('a normal estimate with no prior invoice still mints every milestone exactly as before (only the first carries estimate_id)', async () => {
      const s = await seedAcceptedEstimate('D-NORMAL', 100000);
      const proposal = approvedSchedule(s, DEPOSIT_THEN_BALANCE);
      const result = await handler.execute(proposal, { tenantId: s.tenantId, executedBy: s.userId });
      expect(result.success).toBe(true);
      expect(await completeJob(s)).toHaveLength(1);

      const rows = await invoiceRows(s);
      expect(rows).toEqual([
        { invoice_number: 'INV-0001', estimate_id: s.estimateId, schedule_id: result.resultEntityId, milestone_index: 0, total_cents: 50000 },
        { invoice_number: 'INV-0002', estimate_id: null, schedule_id: result.resultEntityId, milestone_index: 1, total_cents: 50000 },
      ]);
      expect(rows.reduce((sum, r) => sum + r.total_cents, 0)).toBe(100000);

      // The schedule's OWN deposit carries the estimate id: a retried approval
      // and a retried completion are not "invoiced outside the schedule".
      const retry = await handler.execute(proposal, { tenantId: s.tenantId, executedBy: s.userId });
      expect(retry).toEqual({ success: true, resultEntityId: result.resultEntityId });
      expect(await completeJob(s)).toEqual([]);
      expect(await invoiceRows(s)).toEqual(rows);
    });

    it("T1 — tenant B mints its own plan in the same run and is untouched by tenant A's refusal", async () => {
      const tenantB = await seedAcceptedEstimate('T1-B-NEIGHBOUR', 240000);
      const bResult = await handler.execute(approvedSchedule(tenantB, DEPOSIT_THEN_BALANCE), {
        tenantId: tenantB.tenantId,
        executedBy: tenantB.userId,
      });
      expect(bResult.success).toBe(true);
      await completeJob(tenantB);
      const bBefore = await invoiceRows(tenantB);
      expect(bBefore.map((r) => r.total_cents)).toEqual([120000, 120000]);
      expect(bBefore.map((r) => r.estimate_id)).toEqual([tenantB.estimateId, null]);

      const tenantA = await seedAcceptedEstimate('T1-A-CONVERTED', 100000);
      const converted = await convert(tenantA);
      const aResult = await handler.execute(approvedSchedule(tenantA, DEPOSIT_THEN_BALANCE), {
        tenantId: tenantA.tenantId,
        executedBy: tenantA.userId,
      });
      await completeJob(tenantA);

      expect(await invoiceRows(tenantA)).toEqual([convertedRow(tenantA, converted.invoiceNumber)]);
      expect(aResult.success).toBe(false);
      // Tenant B's plan did not move, and neither tenant reads the other's invoices.
      expect(await invoiceRows(tenantB)).toEqual(bBefore);
      expect(await invoiceRepo.findByJob(tenantB.tenantId, tenantA.job.id)).toEqual([]);
      expect(await invoiceRepo.findByJob(tenantA.tenantId, tenantB.job.id)).toEqual([]);
    });
  });
});
