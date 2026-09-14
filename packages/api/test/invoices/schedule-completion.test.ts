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
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
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

  // #1203: the estimate was converted to a plain invoice outside the schedule.
  // Minting the balance next to it would bill the estimate twice.
  async function seedConvertedInvoice(job: Job, estimateId: string, overrides: { status?: 'canceled' | 'void'; amountPaidCents?: number } = {}) {
    const converted = await createInvoice(
      {
        tenantId: TENANT,
        jobId: job.id,
        estimateId,
        invoiceNumber: 'INV-CONVERTED',
        lineItems: [buildLineItem('c1', 'Whole job', 1, 20000, 0, true)],
        createdBy: 'u1',
      },
      invoiceRepo,
    );
    if (overrides.status || overrides.amountPaidCents) {
      await invoiceRepo.update(TENANT, converted.id, {
        ...(overrides.status ? { status: overrides.status } : {}),
        ...(overrides.amountPaidCents ? { amountPaidCents: overrides.amountPaidCents } : {}),
      });
    }
    return converted;
  }

  it('refuses to mint when the estimate was already invoiced outside the schedule, and audits the refusal for the owner', async () => {
    const job = makeJob();
    const estimateId = uuidv4();
    const schedule = await seedScheduleWithDeposit(job, { estimateId, depositCarriesEstimate: false });
    const converted = await seedConvertedInvoice(job, estimateId);

    await expect(mintCompletionMilestones(deps(), job)).rejects.toMatchObject({
      name: 'ConflictError',
      message: expect.stringMatching(/already invoiced as INV-CONVERTED/),
    });
    // Only the legacy deposit and the converted invoice: no balance was minted.
    expect(await invoiceRepo.findByJob(TENANT, job.id)).toHaveLength(2);
    const refused = auditRepo.getAll().filter((e) => e.eventType === 'invoice.milestone_mint_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ entityType: 'job', entityId: job.id, actorRole: 'system' });
    expect(refused[0].metadata).toMatchObject({
      scheduleId: schedule.id,
      blockingInvoiceId: converted.id,
      blockingInvoiceNumber: 'INV-CONVERTED',
    });
  });

  it('refuses a voice-shaped schedule (no estimateId) when an estimate on the job was already invoiced', async () => {
    const job = makeJob();
    await seedScheduleWithDeposit(job); // CreateInvoiceScheduleTaskHandler never sets estimateId
    await seedConvertedInvoice(job, uuidv4());

    await expect(mintCompletionMilestones(deps(), job)).rejects.toThrow(/already invoiced as INV-CONVERTED/);
    expect(await invoiceRepo.findByJob(TENANT, job.id)).toHaveLength(2);
  });

  it('mints when the converted invoice was canceled, or voided with no payment', async () => {
    for (const status of ['canceled', 'void'] as const) {
      const job = makeJob();
      await seedScheduleWithDeposit(job);
      await seedConvertedInvoice(job, uuidv4(), { status });

      const created = await mintCompletionMilestones(deps(), job);
      expect(created.map((i) => i.milestoneIndex)).toEqual([1]);
    }
    expect(auditRepo.getAll().filter((e) => e.eventType === 'invoice.milestone_mint_refused')).toEqual([]);
  });

  it('still refuses when the voided converted invoice carries a payment', async () => {
    const job = makeJob();
    await seedScheduleWithDeposit(job);
    await seedConvertedInvoice(job, uuidv4(), { status: 'void', amountPaidCents: 5000 });

    await expect(mintCompletionMilestones(deps(), job)).rejects.toThrow(/already invoiced as INV-CONVERTED/);
  });

  it('does not refuse (or audit) a schedule that has nothing left to mint', async () => {
    const job = makeJob();
    const schedule = await seedScheduleWithDeposit(job);
    // The balance was already minted on an earlier completion…
    await createInvoice(
      {
        tenantId: TENANT,
        jobId: job.id,
        invoiceNumber: 'INV-2',
        lineItems: [buildLineItem('b1', 'Balance', 1, 10000, 0, true)],
        scheduleId: schedule.id,
        milestoneIndex: 1,
        createdBy: 'u1',
      },
      invoiceRepo,
    );
    // …and an estimate invoice appeared afterwards. Re-completion has nothing to mint.
    await seedConvertedInvoice(job, uuidv4());

    expect(await mintCompletionMilestones(deps(), job)).toEqual([]);
    expect(auditRepo.getAll().filter((e) => e.eventType === 'invoice.milestone_mint_refused')).toEqual([]);
  });

  it('refuses while an invoice auto-drafted at an earlier completion is waiting for approval', async () => {
    const job = makeJob();
    await seedScheduleWithDeposit(job);
    const proposalRepo = new InMemoryProposalRepository();
    const autoDraft = await proposalRepo.create(
      createProposal({
        tenantId: TENANT,
        proposalType: 'draft_invoice',
        payload: { jobId: job.id, customerId: job.customerId, lineItems: [] },
        summary: 'Draft invoice for completed job',
        idempotencyKey: `auto_invoice:${job.id}`,
        createdBy: 'system:auto_invoice',
      }),
    );

    await expect(mintCompletionMilestones({ ...deps(), proposalRepo }, job)).rejects.toThrow(/auto-drafted/i);
    expect(await invoiceRepo.findByJob(TENANT, job.id)).toHaveLength(1);
    const refused = auditRepo.getAll().filter((e) => e.eventType === 'invoice.milestone_mint_refused');
    expect(refused[0].metadata).toMatchObject({ pendingProposalId: autoDraft.id });

    // Once the owner rejects that draft, the plan bills again.
    await proposalRepo.updateStatus(TENANT, autoDraft.id, 'rejected');
    const created = await mintCompletionMilestones({ ...deps(), proposalRepo }, job);
    expect(created.map((i) => i.milestoneIndex)).toEqual([1]);
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
