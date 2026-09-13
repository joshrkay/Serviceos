/**
 * §8.11 Milestone (progress) billing — the split PERSISTED at real Postgres.
 *
 * `splitMilestones` (invoices/invoice-schedule.ts:112) guarantees
 * `Σ amountCents === totalCents`, with the single `remainder` milestone
 * absorbing the rounding. That was proven only in unit tests: nothing checked
 * that the invoices actually minted from a schedule carry those amounts, that
 * the remainder cent lands on the remainder milestone's INVOICE, or what row
 * shape `schedule-completion.ts` writes.
 *
 * Both minting paths are driven here, against real repositories:
 *   - `CreateInvoiceScheduleExecutionHandler` (proposals/execution/
 *     invoice-schedule-handler.ts:186) drafts each `on_accept` milestone;
 *   - `mintCompletionMilestones` (invoices/schedule-completion.ts:38) drafts
 *     each `on_completion` milestone when the job completes.
 *
 * The schedule is 100.00 split three ways at 3333 bps / 3333 bps / remainder:
 * 3333 + 3333 + 3334 — so the extra cent is visible on the LAST milestone and
 * a drift in either path shows up as a sum that is not 10000.
 *
 * Also pinned: PR #1029's owner control `milestoneBillingEnabled` (the
 * completion path mints NOTHING when the tenant has not opted in), idempotency
 * on re-entry, the `invoice.milestone_minted` audit row through
 * `PgAuditRepository.findByEntity`, and T1 — a second tenant's schedule mints
 * its own invoices in the same run without touching the first tenant's.
 *
 * Runs only under the integration harness (globalSetup starts the Postgres
 * testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgInvoiceScheduleRepository } from '../../src/invoices/pg-invoice-schedule';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { CreateInvoiceScheduleExecutionHandler } from '../../src/proposals/execution/invoice-schedule-handler';
import { mintCompletionMilestones } from '../../src/invoices/schedule-completion';
import { InvoiceMilestone } from '../../src/invoices/invoice-schedule';
import { Invoice } from '../../src/invoices/invoice';
import { Job } from '../../src/jobs/job';
import { Proposal } from '../../src/proposals/proposal';

/** 100.00 split 1/3 – 1/3 – remainder: 3333 + 3333 + 3334 = 10000. */
const SCHEDULE_TOTAL_CENTS = 10_000;
const MILESTONES: InvoiceMilestone[] = [
  { label: 'Deposit', type: 'percent', value: 3333, trigger: 'on_accept' },
  { label: 'Progress', type: 'percent', value: 3333, trigger: 'on_completion' },
  { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
];

interface SeededJob {
  tenantId: string;
  userId: string;
  jobId: string;
  job: Job;
}

describe('Postgres integration — milestone billing persisted (§8.11)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let scheduleRepo: PgInvoiceScheduleRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let handler: CreateInvoiceScheduleExecutionHandler;

  async function seedJob(milestoneBillingEnabled: boolean): Promise<SeededJob> {
    const { tenantId, userId } = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: uuidv4(),
      tenantId,
      businessName: 'Milestone Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
    await settingsRepo.update(tenantId, { milestoneBillingEnabled });

    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Mile',
      lastName: 'Stone',
      displayName: 'Mile Stone',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const locationId = uuidv4();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1 Stage Rd',
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
    const jobId = uuidv4();
    const job = await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `J-${jobId.slice(0, 8)}`,
      summary: 'Big staged job',
      status: 'completed',
      priority: 'normal',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return { tenantId, userId, jobId, job };
  }

  function scheduleProposal(seeded: SeededJob): Proposal {
    return {
      id: uuidv4(),
      tenantId: seeded.tenantId,
      proposalType: 'create_invoice_schedule',
      status: 'approved',
      payload: {
        jobId: seeded.jobId,
        totalAmountCents: SCHEDULE_TOTAL_CENTS,
        milestones: MILESTONES,
      },
      summary: 'Bill in stages',
      createdBy: seeded.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /** Draft the on_accept milestone, then the on_completion ones. */
  async function mintAll(seeded: SeededJob): Promise<Invoice[]> {
    const result = await handler.execute(scheduleProposal(seeded), {
      tenantId: seeded.tenantId,
      executedBy: seeded.userId,
    });
    expect(result.success).toBe(true);
    await mintCompletionMilestones(
      { scheduleRepo, invoiceRepo, settingsRepo, auditRepo },
      seeded.job,
    );
    return invoiceRepo.findByJob(seeded.tenantId, seeded.jobId);
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    scheduleRepo = new PgInvoiceScheduleRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    handler = new CreateInvoiceScheduleExecutionHandler(
      scheduleRepo,
      invoiceRepo,
      settingsRepo,
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('mints one invoice per milestone whose amounts sum to the schedule total, with the remainder cent on the last', async () => {
    const seeded = await seedJob(true);
    const invoices = await mintAll(seeded);

    const byIndex = [...invoices].sort((a, b) => a.milestoneIndex! - b.milestoneIndex!);
    expect(byIndex.map((i) => i.milestoneIndex)).toEqual([0, 1, 2]);

    const amounts = byIndex.map((i) => i.totals.totalCents);
    expect(amounts).toEqual([3333, 3333, 3334]);
    // The §8.11 claim, on persisted rows: Σ milestones === the schedule total.
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(SCHEDULE_TOTAL_CENTS);
    // …and the odd cent sits on the remainder milestone, which is the last one.
    expect(amounts[2] - amounts[1]).toBe(1);

    // Read the same thing straight out of Postgres, not through the mapper.
    const { rows } = await pool.query<{ milestone_index: number; total_cents: string }>(
      `SELECT milestone_index, total_cents FROM invoices
       WHERE tenant_id = $1 AND job_id = $2 ORDER BY milestone_index`,
      [seeded.tenantId, seeded.jobId],
    );
    expect(rows.map((r) => Number(r.total_cents))).toEqual([3333, 3333, 3334]);
    expect(rows.reduce((sum, r) => sum + Number(r.total_cents), 0)).toBe(
      SCHEDULE_TOTAL_CENTS,
    );

    const schedule = (await scheduleRepo.findByJob(seeded.tenantId, seeded.jobId))[0];
    expect(schedule.totalAmountCents).toBe(SCHEDULE_TOTAL_CENTS);
    expect(byIndex.every((i) => i.scheduleId === schedule.id)).toBe(true);
  });

  it('the completion path mints NUMBERED DRAFT invoices — one labelled line each, linked to the schedule, audited', async () => {
    const seeded = await seedJob(true);
    const invoices = await mintAll(seeded);
    const byIndex = [...invoices].sort((a, b) => a.milestoneIndex! - b.milestoneIndex!);

    // Row shape of the two on_completion mints (schedule-completion.ts:79-95).
    for (const inv of byIndex.slice(1)) {
      expect(inv.status).toBe('draft');
      // A real number off the tenant's sequence — never a PENDING- placeholder.
      expect(inv.invoiceNumber).toMatch(/^INV\d{4}$/);
      expect(inv.lineItems).toHaveLength(1);
      expect(inv.lineItems[0].quantity).toBe(1);
      expect(inv.lineItems[0].taxable).toBe(true);
      expect(inv.amountPaidCents).toBe(0);
      expect(inv.amountDueCents).toBe(inv.totals.totalCents);

      const audits = await auditRepo.findByEntity(seeded.tenantId, 'invoice', inv.id);
      const minted = audits.filter((a) => a.eventType === 'invoice.milestone_minted');
      expect(minted).toHaveLength(1);
      expect(minted[0].metadata).toMatchObject({
        milestoneIndex: inv.milestoneIndex,
        amountCents: inv.totals.totalCents,
      });
    }
    expect(byIndex[1].lineItems[0].description).toBe('Progress');
    expect(byIndex[2].lineItems[0].description).toBe('Balance');

    // Each milestone was numbered from the tenant's own sequence, in order.
    expect(byIndex.map((i) => i.invoiceNumber)).toEqual(['INV0001', 'INV0002', 'INV0003']);

    // Re-entry (a retried completion) mints nothing more.
    const again = await mintCompletionMilestones(
      { scheduleRepo, invoiceRepo, settingsRepo, auditRepo },
      seeded.job,
    );
    expect(again).toEqual([]);
    expect(await invoiceRepo.findByJob(seeded.tenantId, seeded.jobId)).toHaveLength(3);
  });

  it('mints no completion milestone for a tenant that has not enabled milestone billing (PR #1029 owner control)', async () => {
    const seeded = await seedJob(false);

    const result = await handler.execute(scheduleProposal(seeded), {
      tenantId: seeded.tenantId,
      executedBy: seeded.userId,
    });
    expect(result.success).toBe(true);

    const minted = await mintCompletionMilestones(
      { scheduleRepo, invoiceRepo, settingsRepo, auditRepo },
      seeded.job,
    );
    expect(minted).toEqual([]);

    // Only the on_accept deposit exists; the balance was NOT billed.
    const invoices = await invoiceRepo.findByJob(seeded.tenantId, seeded.jobId);
    expect(invoices.map((i) => i.milestoneIndex)).toEqual([0]);
    expect(invoices[0].totals.totalCents).toBe(3333);
  });

  it('T1 — a second tenant mints its own milestones in the same run and neither schedule is visible to the other', async () => {
    const tenantA = await seedJob(true);
    const tenantB = await seedJob(true);

    const aInvoices = await mintAll(tenantA);
    const bInvoices = await mintAll(tenantB);

    expect(aInvoices).toHaveLength(3);
    expect(bInvoices).toHaveLength(3);
    expect(
      bInvoices.map((i) => i.totals.totalCents).reduce((a, b) => a + b, 0),
    ).toBe(SCHEDULE_TOTAL_CENTS);

    // Tenant A's set did not move while tenant B minted.
    const aAfter = await invoiceRepo.findByJob(tenantA.tenantId, tenantA.jobId);
    expect(aAfter).toHaveLength(3);
    expect(aAfter.map((i) => i.id).sort()).toEqual(aInvoices.map((i) => i.id).sort());

    // Cross-tenant: neither tenant can read the other's schedule or invoices.
    const aSchedule = (await scheduleRepo.findByJob(tenantA.tenantId, tenantA.jobId))[0];
    expect(await scheduleRepo.findById(tenantB.tenantId, aSchedule.id)).toBeNull();
    expect(await invoiceRepo.findByJob(tenantB.tenantId, tenantA.jobId)).toEqual([]);
    expect(
      await auditRepo.findByEntity(tenantB.tenantId, 'invoice', aInvoices[0].id),
    ).toEqual([]);
  });
});
