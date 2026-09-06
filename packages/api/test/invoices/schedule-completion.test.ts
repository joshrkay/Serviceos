import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { mintCompletionMilestones } from '../../src/invoices/schedule-completion';
import { MILESTONE_UNIQUE_INDEX } from '../../src/invoices/invoice-schedule';
import { InMemoryInvoiceRepository, createInvoice } from '../../src/invoices/invoice';
import {
  InMemoryInvoiceScheduleRepository,
  buildInvoiceSchedule,
  InvoiceMilestone,
} from '../../src/invoices/invoice-schedule';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem } from '../../src/shared/billing-engine';
import { Job } from '../../src/jobs/job';

const TENANT = 'tenant-sched-complete';

const depositBalance: InvoiceMilestone[] = [
  { label: 'Deposit', type: 'percent', value: 5000, trigger: 'on_accept' },
  { label: 'Balance', type: 'remainder', value: 0, trigger: 'on_completion' },
];

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId: uuidv4(),
    locationId: uuidv4(),
    jobNumber: 'JOB-1',
    summary: 'Reno',
    status: 'completed',
    priority: 'normal',
    depositRequiredCents: 0,
    depositPaidCents: 0,
    depositStatus: 'not_required',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSettings(): TenantSettings {
  return {
    id: `settings-${TENANT}`,
    tenantId: TENANT,
    businessName: 'Rivera HVAC',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    // Milestone billing is opt-in (P0 launch hardening): these tests exercise
    // the minting path, so they enable it. The gate itself is covered below.
    milestoneBillingEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('mintCompletionMilestones', () => {
  let scheduleRepo: InMemoryInvoiceScheduleRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    scheduleRepo = new InMemoryInvoiceScheduleRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    await settingsRepo.create(makeSettings());
  });

  function deps() {
    return { scheduleRepo, invoiceRepo, settingsRepo, auditRepo };
  }

  async function seedScheduleWithDeposit(
    job: Job,
    opts: { estimateId?: string; depositCarriesEstimate?: boolean } = {},
  ) {
    const schedule = buildInvoiceSchedule({
      tenantId: TENANT,
      jobId: job.id,
      estimateId: opts.estimateId,
      totalAmountCents: 20000,
      milestones: depositBalance,
      createdBy: 'u1',
    });
    await scheduleRepo.create(schedule);
    // The on_accept deposit was minted at schedule approval (milestone 0).
    await createInvoice(
      {
        tenantId: TENANT,
        jobId: job.id,
        estimateId: opts.depositCarriesEstimate ? opts.estimateId : undefined,
        invoiceNumber: 'INV-1',
        lineItems: [buildLineItem('d1', 'Deposit', 1, 10000, 0, true)],
        scheduleId: schedule.id,
        milestoneIndex: 0,
        createdBy: 'u1',
      },
      invoiceRepo,
    );
    return schedule;
  }

  /** Simulate Postgres rejecting the next INSERT with a duplicate-key error. */
  function failNextCreateWith(constraint: string) {
    const original = invoiceRepo.create.bind(invoiceRepo);
    let armed = true;
    invoiceRepo.create = async (invoice) => {
      if (armed) {
        armed = false;
        throw Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
          code: '23505',
          constraint,
        });
      }
      return original(invoice);
    };
  }

  it('mints the on_completion balance milestone on completion', async () => {
    const job = makeJob();
    const schedule = await seedScheduleWithDeposit(job);

    const created = await mintCompletionMilestones(deps(), job);
    expect(created).toHaveLength(1);
    expect(created[0].scheduleId).toBe(schedule.id);
    expect(created[0].milestoneIndex).toBe(1);
    expect(created[0].totals.totalCents).toBe(10000); // the remaining 50%

    const all = await invoiceRepo.findByJob(TENANT, job.id);
    expect(all).toHaveLength(2); // deposit + balance
    expect(auditRepo.getAll().some((e) => e.eventType === 'invoice.milestone_minted')).toBe(true);
  });

  it('is idempotent — a second completion mints nothing new', async () => {
    const job = makeJob();
    await seedScheduleWithDeposit(job);

    await mintCompletionMilestones(deps(), job);
    const second = await mintCompletionMilestones(deps(), job);
    expect(second).toHaveLength(0);
    expect(await invoiceRepo.findByJob(TENANT, job.id)).toHaveLength(2);
  });

  // Regression: uq_invoices_estimate allows one invoice per estimate. The
  // deposit minted at approval carries the link, so the balance must not, or
  // its INSERT is rejected — and the old catch swallowed that as "already
  // minted", leaving the balance unbilled with no error anywhere.
  it('does not re-link the estimate already linked by the deposit', async () => {
    const job = makeJob();
    const estimateId = uuidv4();
    await seedScheduleWithDeposit(job, { estimateId, depositCarriesEstimate: true });

    const created = await mintCompletionMilestones(deps(), job);
    expect(created).toHaveLength(1);
    expect(created[0].milestoneIndex).toBe(1);
    expect(created[0].estimateId).toBeUndefined();
  });

  it('carries the estimate link when no earlier invoice on the job holds it', async () => {
    const job = makeJob();
    const estimateId = uuidv4();
    await seedScheduleWithDeposit(job, { estimateId, depositCarriesEstimate: false });

    const created = await mintCompletionMilestones(deps(), job);
    expect(created).toHaveLength(1);
    expect(created[0].estimateId).toBe(estimateId);
  });

  it('treats a duplicate on the (schedule, milestone) index as already minted', async () => {
    const job = makeJob();
    await seedScheduleWithDeposit(job);
    failNextCreateWith(MILESTONE_UNIQUE_INDEX);

    const created = await mintCompletionMilestones(deps(), job);
    expect(created).toHaveLength(0);
    expect(await invoiceRepo.findByJob(TENANT, job.id)).toHaveLength(1);
  });

  it('propagates a 23505 from any other index instead of silently dropping the milestone', async () => {
    const job = makeJob();
    await seedScheduleWithDeposit(job);
    failNextCreateWith('uq_invoices_estimate');

    await expect(mintCompletionMilestones(deps(), job)).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_invoices_estimate',
    });
  });

  it('no-ops for a job with no invoice schedule', async () => {
    const job = makeJob();
    expect(await mintCompletionMilestones(deps(), job)).toHaveLength(0);
  });

  it('does not mint when milestone billing is not opted in (kill switch)', async () => {
    // Disable the opt-in toggle; an approved schedule with a billable
    // on_completion balance must NOT mint.
    await settingsRepo.update(TENANT, { milestoneBillingEnabled: false });
    const job = makeJob();
    await seedScheduleWithDeposit(job);

    const created = await mintCompletionMilestones(deps(), job);
    expect(created).toHaveLength(0);
    // Only the pre-existing deposit invoice remains — no balance minted.
    expect(await invoiceRepo.findByJob(TENANT, job.id)).toHaveLength(1);
  });

  it('does not mint manual milestones on completion', async () => {
    const job = makeJob();
    const schedule = buildInvoiceSchedule({
      tenantId: TENANT,
      jobId: job.id,
      totalAmountCents: 30000,
      milestones: [
        { label: 'Deposit', type: 'percent', value: 5000, trigger: 'on_accept' },
        { label: 'Mid', type: 'percent', value: 2500, trigger: 'manual' },
        { label: 'Final', type: 'remainder', value: 0, trigger: 'on_completion' },
      ],
      createdBy: 'u1',
    });
    await scheduleRepo.create(schedule);

    const created = await mintCompletionMilestones(deps(), job);
    // Only the on_completion 'Final' (remainder) mints; 'Mid' (manual) does not.
    expect(created).toHaveLength(1);
    expect(created[0].milestoneIndex).toBe(2);
  });
});
