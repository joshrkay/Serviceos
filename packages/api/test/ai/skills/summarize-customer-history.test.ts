import { describe, it, expect, vi } from 'vitest';
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

function makeInvoice(overrides: Partial<Invoice> & Pick<Invoice, 'id' | 'amountDueCents' | 'status'>): Invoice {
  return {
    id: overrides.id,
    tenantId: TENANT,
    jobId: 'job-1',
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
  it('returns empty arrays + first-time-caller flag for unknown customer', async () => {
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
    expect(result.activeAgreements).toEqual([]);
    expect(result.flags.isFirstTimeCaller).toBe(true);
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

  it('aggregates open balances + flags overdue when oldest dueDate is past', async () => {
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const agreementRepo = new InMemoryAgreementRepository();

    await invoiceRepo.create(
      makeInvoice({
        id: 'inv-1',
        amountDueCents: 12000,
        status: 'open',
        dueDate: new Date('2026-04-15'), // overdue (today is 2026-05-03)
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
    // Paid invoice — must NOT count toward open balance.
    await invoiceRepo.create(
      makeInvoice({
        id: 'inv-3',
        amountDueCents: 0,
        status: 'paid',
        jobId: 'job-3',
      }),
    );

    // Filter by customerId: invoice has no customerId column, but findByTenant
    // accepts a customerId option that filters via job lookup. The InMemory
    // repo's filter is on `customerId` option directly; for this test we
    // populate jobs so the customerId filter path resolves.
    const jobRepoForFilter = new InMemoryJobRepository();
    await jobRepoForFilter.create(
      makeJob({ id: 'job-1', createdAt: new Date('2026-04-01') }),
    );
    await jobRepoForFilter.create(
      makeJob({ id: 'job-2', createdAt: new Date('2026-04-15') }),
    );
    await jobRepoForFilter.create(
      makeJob({ id: 'job-3', createdAt: new Date('2026-05-01') }),
    );

    // Use the unfiltered invoice repo so the customerId filter path runs.
    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER },
      { jobRepo: jobRepoForFilter, invoiceRepo, agreementRepo },
    );

    // Only open + partially_paid; paid skipped.
    expect(result.openInvoices.count).toBe(2);
    expect(result.openInvoices.totalDueCents).toBe(17000);
    expect(result.openInvoices.oldestDueDate).toEqual(new Date('2026-04-15'));
    // 2026-04-15 is past today (test runs as if today is 2026-05-03 per CLAUDE.md).
    expect(result.flags.hasOverdueBalance).toBe(true);
  });

  it('filters agreements to customer-scoped active rows', async () => {
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
    // Cancelled agreement — must NOT show.
    await agreementRepo.create(
      makeAgreement({
        id: 'agr-3',
        name: 'Cancelled Plan',
        status: 'cancelled',
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

  it('flags hasOpenWorkOrders when a recent job is in non-terminal status', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(
      makeJob({
        id: 'job-1',
        createdAt: new Date('2026-04-01'),
        status: 'in_progress',
      }),
    );
    const invoiceRepo = new InMemoryInvoiceRepository();
    const agreementRepo = new InMemoryAgreementRepository();

    const result = await summarizeCustomerHistory(
      { tenantId: TENANT, customerId: CUSTOMER },
      { jobRepo, invoiceRepo, agreementRepo },
    );

    expect(result.flags.hasOpenWorkOrders).toBe(true);
  });

  it('exposes lastTechnicianId from the most-recent job that has one', async () => {
    const jobRepo = new InMemoryJobRepository();
    // Newer job: no tech assigned. Older job: tech assigned. Should
    // surface the older job's tech (the most-recent one we know of).
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

  it('failure-soft: invoice repo throws → openInvoices marked unavailable, rest of summary still builds', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(
      makeJob({ id: 'job-1', createdAt: new Date('2026-05-01') }),
    );
    const invoiceRepo = new InMemoryInvoiceRepository();
    vi.spyOn(invoiceRepo, 'findByTenant').mockRejectedValue(
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
    // hasOverdueBalance must be false when balance is unavailable
    // (don't pretend the customer is overdue based on stale data).
    expect(result.flags.hasOverdueBalance).toBe(false);
  });

  it('failure-soft: jobRepo without findByCustomer → empty job list, flags first-time caller', async () => {
    // A repo that does NOT implement findByCustomer (the optional method).
    const jobRepo: Pick<InMemoryJobRepository, 'create' | 'findById' | 'findByTenant' | 'update' | 'getNextJobNumber'> = {
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

    expect(result.recentJobs).toEqual([]);
    expect(result.flags.isFirstTimeCaller).toBe(true);
  });
});
