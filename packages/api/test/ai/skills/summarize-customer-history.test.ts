import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { summarizeCustomerHistory } from '../../../src/ai/skills/summarize-customer-history';
import { InMemoryJobRepository, type Job } from '../../../src/jobs/job';
import {
  InMemoryInvoiceRepository,
  type Invoice,
} from '../../../src/invoices/invoice';
import {
  InMemoryAgreementRepository,
  type Agreement,
} from '../../../src/agreements/agreement';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const OTHER_CUSTOMER = '33333333-3333-3333-3333-333333333333';

function makeJob(overrides: Partial<Job> & Pick<Job, 'id' | 'createdAt'>): Job {
  return {
    id: overrides.id,
    tenantId: TENANT,
    customerId: CUSTOMER,
    locationId: 'loc-1',
    jobNumber: '1001',
    summary: 'Furnace not heating',
    status: 'completed',
    priority: 'normal',
    createdBy: 'user-1',
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

function makeInvoice(
  overrides: Partial<Invoice> & Pick<Invoice, 'id' | 'amountDueCents' | 'status' | 'jobId'>,
): Invoice {
  return {
    id: overrides.id,
    tenantId: TENANT,
    jobId: overrides.jobId,
    invoiceNumber: 'INV-1',
    status: overrides.status,
    lineItems: [],
    totals: { subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 },
    amountPaidCents: 0,
    amountDueCents: overrides.amountDueCents,
    createdBy: 'user-1',
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...overrides,
  };
}

function makeAgreement(
  overrides: Partial<Agreement> & Pick<Agreement, 'id' | 'name'>,
): Agreement {
  return {
    id: overrides.id,
    tenantId: TENANT,
    customerId: CUSTOMER,
    name: overrides.name,
    recurrenceRule: 'FREQ=MONTHLY',
    priceCents: 9900,
    autoGenerateInvoice: true,
    autoGenerateJob: false,
    nextRunAt: new Date('2026-06-01'),
    status: 'active',
    startsOn: '2026-01-01',
    createdBy: 'user-1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('summarizeCustomerHistory', () => {
  // Pin time so date-comparisons in hasOverdueBalance are deterministic
  // regardless of when the test suite runs (gemini high review fix).
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns first-time-caller flag for unknown customer (jobs queryable, none found)', async () => {
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const agreementRepo = new InMemoryAgreementRepository();

    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER },
      { jobRepo, invoiceRepo, agreementRepo },
    );

    expect(result.recentJobs).toEqual([]);
    expect(result.openInvoices.count).toBe(0);
    expect(result.openInvoices.totalDueCents).toBe(0);
    expect(result.openInvoices.unavailable).toBeUndefined();
    expect(result.activeAgreements).toEqual([]);
    expect(result.flags.isFirstTimeCaller).toBe(true);
    expect(result.flags.jobHistoryUnavailable).toBe(false);
    expect(result.flags.hasOpenWorkOrders).toBe(false);
    expect(result.flags.isAgreementHolder).toBe(false);
    expect(result.flags.hasOverdueBalance).toBe(false);
    expect(result.lastTechnicianId).toBeUndefined();
  });

  it('returns recent jobs newest-first, capped at recentJobLimit', async () => {
    const jobRepo = new InMemoryJobRepository();
    for (let i = 0; i < 8; i++) {
      await jobRepo.create(
        makeJob({
          id: `job-${i}`,
          createdAt: new Date(2026, 3, i + 1),
          summary: `Visit ${i}`,
        }),
      );
    }
    const invoiceRepo = new InMemoryInvoiceRepository();
    const agreementRepo = new InMemoryAgreementRepository();

    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER, recentJobLimit: 3 },
      { jobRepo, invoiceRepo, agreementRepo },
    );

    expect(result.recentJobs).toHaveLength(3);
    expect(result.recentJobs[0].summary).toBe('Visit 7');
    expect(result.recentJobs[2].summary).toBe('Visit 5');
    expect(result.flags.isFirstTimeCaller).toBe(false);
  });

  it('hasOpenWorkOrders is computed from FULL job set, not just the recent slice', async () => {
    const jobRepo = new InMemoryJobRepository();
    // 6 completed jobs (newest) + 1 in_progress job (oldest, beyond default limit of 5)
    for (let i = 0; i < 6; i++) {
      await jobRepo.create(
        makeJob({
          id: `recent-${i}`,
          createdAt: new Date(2026, 3, 10 + i),
          summary: `Recent ${i}`,
          status: 'completed',
        }),
      );
    }
    await jobRepo.create(
      makeJob({
        id: 'old-active',
        createdAt: new Date(2026, 0, 1),
        summary: 'Old still-active job',
        status: 'in_progress',
      }),
    );
    const invoiceRepo = new InMemoryInvoiceRepository();
    const agreementRepo = new InMemoryAgreementRepository();

    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER, recentJobLimit: 5 },
      { jobRepo, invoiceRepo, agreementRepo },
    );

    // recentJobs slice does NOT include old-active.
    expect(result.recentJobs.find((j) => j.id === 'old-active')).toBeUndefined();
    // But hasOpenWorkOrders DOES detect it.
    expect(result.flags.hasOpenWorkOrders).toBe(true);
  });

  it('aggregates open balances across customer jobs only, ignoring other customers and paid invoices', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(
      makeJob({ id: 'job-1', createdAt: new Date('2026-04-01') }),
    );
    await jobRepo.create(
      makeJob({ id: 'job-2', createdAt: new Date('2026-04-15') }),
    );
    // Other customer's job — must not contribute.
    await jobRepo.create(
      makeJob({
        id: 'job-other',
        customerId: OTHER_CUSTOMER,
        createdAt: new Date('2026-04-20'),
      }),
    );
    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(
      makeInvoice({
        id: 'inv-1',
        amountDueCents: 12000,
        status: 'open',
        dueDate: new Date('2026-04-15'),
        jobId: 'job-1',
      }),
    );
    await invoiceRepo.create(
      makeInvoice({
        id: 'inv-2',
        amountDueCents: 5000,
        status: 'partially_paid',
        dueDate: new Date('2026-05-30'),
        jobId: 'job-2',
      }),
    );
    // Paid — must not count.
    await invoiceRepo.create(
      makeInvoice({
        id: 'inv-3',
        amountDueCents: 0,
        status: 'paid',
        jobId: 'job-2',
      }),
    );
    // Other customer's open invoice — must not contribute.
    await invoiceRepo.create(
      makeInvoice({
        id: 'inv-other',
        amountDueCents: 99999,
        status: 'open',
        dueDate: new Date('2026-04-01'),
        jobId: 'job-other',
      }),
    );
    const agreementRepo = new InMemoryAgreementRepository();

    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER },
      { jobRepo, invoiceRepo, agreementRepo },
    );

    expect(result.openInvoices.count).toBe(2);
    expect(result.openInvoices.totalDueCents).toBe(17000); // 12000 + 5000, NOT 99999
    expect(result.openInvoices.oldestDueDate).toEqual(new Date('2026-04-15'));
    // Today is pinned to 2026-05-03; 2026-04-15 is past.
    expect(result.flags.hasOverdueBalance).toBe(true);
  });

  it('filters agreements to customer-scoped active rows (relies on repo, no client-side re-filter)', async () => {
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const agreementRepo = new InMemoryAgreementRepository();

    await agreementRepo.create(
      makeAgreement({
        id: 'agr-1',
        name: 'Platinum Plan',
        priceCents: 19900,
      }),
    );
    await agreementRepo.create(
      makeAgreement({
        id: 'agr-2',
        name: "Other Customer's Plan",
        customerId: OTHER_CUSTOMER,
      }),
    );

    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER },
      { jobRepo, invoiceRepo, agreementRepo },
    );

    expect(result.activeAgreements).toHaveLength(1);
    expect(result.activeAgreements[0].name).toBe('Platinum Plan');
    expect(result.flags.isAgreementHolder).toBe(true);
  });

  it('exposes lastTechnicianId from the most-recent job that has one', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(
      makeJob({ id: 'job-newer', createdAt: new Date('2026-05-01') }),
    );
    await jobRepo.create(
      makeJob({
        id: 'job-older',
        createdAt: new Date('2026-04-01'),
        assignedTechnicianId: 'tech-mike',
      }),
    );
    const invoiceRepo = new InMemoryInvoiceRepository();
    const agreementRepo = new InMemoryAgreementRepository();

    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER },
      { jobRepo, invoiceRepo, agreementRepo },
    );

    expect(result.lastTechnicianId).toBe('tech-mike');
  });

  it('failure-soft: any per-job invoice fetch failure marks balance unavailable + suppresses overdue flag', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(
      makeJob({ id: 'job-1', createdAt: new Date('2026-05-01') }),
    );
    const invoiceRepo = new InMemoryInvoiceRepository();
    vi.spyOn(invoiceRepo, 'findByJob').mockRejectedValue(
      new Error('db connection lost'),
    );
    const agreementRepo = new InMemoryAgreementRepository();

    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER },
      { jobRepo, invoiceRepo, agreementRepo },
    );

    expect(result.openInvoices.unavailable).toBe(true);
    expect(result.openInvoices.count).toBe(0);
    expect(result.recentJobs.length).toBe(1);
    expect(result.flags.hasOverdueBalance).toBe(false);
    // Job history did succeed — first-time caller is false (we have 1 job).
    expect(result.flags.isFirstTimeCaller).toBe(false);
    expect(result.flags.jobHistoryUnavailable).toBe(false);
  });

  it('failure-soft: jobRepo.findByCustomer throws → jobHistoryUnavailable, isFirstTimeCaller false', async () => {
    const jobRepo = new InMemoryJobRepository();
    vi.spyOn(jobRepo, 'findByCustomer').mockRejectedValue(
      new Error('db down'),
    );
    const invoiceRepo = new InMemoryInvoiceRepository();
    const agreementRepo = new InMemoryAgreementRepository();

    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER },
      { jobRepo, invoiceRepo, agreementRepo },
    );

    expect(result.flags.jobHistoryUnavailable).toBe(true);
    // Critical: don't mark a customer "first-time" just because we
    // couldn't reach the DB. Could drive wrong greeting/triage path.
    expect(result.flags.isFirstTimeCaller).toBe(false);
    // Invoice fan-out depends on job set; mark balance unavailable too.
    expect(result.openInvoices.unavailable).toBe(true);
    expect(result.flags.hasOverdueBalance).toBe(false);
  });

  it('failure-soft: jobRepo without findByCustomer method → jobHistoryUnavailable, isFirstTimeCaller false', async () => {
    const jobRepo: Pick<
      InMemoryJobRepository,
      'create' | 'findById' | 'findByTenant' | 'update' | 'getNextJobNumber'
    > = {
      create: async (j) => j,
      findById: async () => null,
      findByTenant: async () => [],
      update: async () => null,
      getNextJobNumber: async () => 1,
    };
    const invoiceRepo = new InMemoryInvoiceRepository();
    const agreementRepo = new InMemoryAgreementRepository();

    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER },
      {
        jobRepo: jobRepo as unknown as InMemoryJobRepository,
        invoiceRepo,
        agreementRepo,
      },
    );

    expect(result.flags.jobHistoryUnavailable).toBe(true);
    expect(result.flags.isFirstTimeCaller).toBe(false);
    expect(result.openInvoices.unavailable).toBe(true);
  });
});
