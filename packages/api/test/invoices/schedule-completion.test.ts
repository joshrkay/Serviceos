import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { mintCompletionMilestones } from '../../src/invoices/schedule-completion';
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

  async function seedScheduleWithDeposit(job: Job) {
    const schedule = buildInvoiceSchedule({
      tenantId: TENANT,
      jobId: job.id,
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

  it('no-ops for a job with no invoice schedule', async () => {
    const job = makeJob();
    expect(await mintCompletionMilestones(deps(), job)).toHaveLength(0);
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
