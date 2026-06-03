import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { findJobsRequiringInvoicing } from '../../src/invoices/invoicing-queue';
import { InMemoryJobRepository, Job, JobMoneyState } from '../../src/jobs/job';
import { InMemoryInvoiceRepository, createInvoice } from '../../src/invoices/invoice';
import { InMemoryEstimateRepository, createEstimate, Estimate } from '../../src/estimates/estimate';
import { buildLineItem, LineItem } from '../../src/shared/billing-engine';

const TENANT = 'tenant-queue';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId: uuidv4(),
    locationId: uuidv4(),
    jobNumber: 'JOB-1',
    summary: 'AC repair',
    status: 'completed',
    priority: 'normal',
    depositRequiredCents: 0,
    depositPaidCents: 0,
    depositStatus: 'not_required',
    moneyState: 'estimate_accepted',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('findJobsRequiringInvoicing', () => {
  let jobRepo: InMemoryJobRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let estimateRepo: InMemoryEstimateRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    estimateRepo = new InMemoryEstimateRepository();
  });

  function deps() {
    return { jobRepo, invoiceRepo, estimateRepo };
  }

  async function seedAcceptedEstimate(jobId: string, lineItems: LineItem[], overrides: Partial<Estimate> = {}) {
    const est = await createEstimate(
      { tenantId: TENANT, jobId, estimateNumber: 'EST-1', lineItems, createdBy: 'u1' },
      estimateRepo,
    );
    return (await estimateRepo.update(TENANT, est.id, { status: 'accepted', ...overrides }))!;
  }

  it('includes a completed, accepted-estimate job with no invoice and totals it', async () => {
    const job = await jobRepo.create(makeJob());
    await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);

    const candidates = await findJobsRequiringInvoicing(TENANT, deps());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].jobId).toBe(job.id);
    expect(candidates[0].customerId).toBe(job.customerId);
    expect(candidates[0].amountCents).toBe(20000);
    expect(candidates[0].lineItems).toHaveLength(1);
  });

  it('carries the accepted estimate discount + tax into the candidate amount', async () => {
    const job = await jobRepo.create(makeJob());
    const est = await createEstimate(
      {
        tenantId: TENANT,
        jobId: job.id,
        estimateNumber: 'EST-1',
        lineItems: [buildLineItem('i1', 'Repair', 1, 20000, 0, true)],
        discountCents: 500,
        taxRateBps: 1000, // 10%
        createdBy: 'u1',
      },
      estimateRepo,
    );
    await estimateRepo.update(TENANT, est.id, { status: 'accepted' });

    const [candidate] = await findJobsRequiringInvoicing(TENANT, deps());
    expect(candidate.discountCents).toBe(500);
    expect(candidate.taxRateBps).toBe(1000);
    // (20000 - 500) * 1.10 = 21450, not the raw 20000.
    expect(candidate.amountCents).toBe(21450);
  });

  it('excludes a job that already has a live invoice', async () => {
    const job = await jobRepo.create(makeJob());
    await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);
    await createInvoice(
      { tenantId: TENANT, jobId: job.id, invoiceNumber: 'INV-1', lineItems: [buildLineItem('i1', 'Repair', 1, 20000, 0, true)], createdBy: 'u1' },
      invoiceRepo,
    );

    expect(await findJobsRequiringInvoicing(TENANT, deps())).toHaveLength(0);
  });

  it('excludes a job in an ineligible money-state', async () => {
    const job = await jobRepo.create(makeJob({ moneyState: 'paid' as JobMoneyState }));
    await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);

    expect(await findJobsRequiringInvoicing(TENANT, deps())).toHaveLength(0);
  });

  it('excludes a completed job with nothing billable (no accepted estimate)', async () => {
    await jobRepo.create(makeJob({ moneyState: 'no_estimate' }));
    expect(await findJobsRequiringInvoicing(TENANT, deps())).toHaveLength(0);
  });

  it('excludes jobs that are not completed', async () => {
    const job = await jobRepo.create(makeJob({ status: 'in_progress' }));
    await seedAcceptedEstimate(job.id, [buildLineItem('i1', 'Repair', 1, 20000, 0, true)]);
    expect(await findJobsRequiringInvoicing(TENANT, deps())).toHaveLength(0);
  });

  it('groups batched invoice/estimate lookups to the right job (no cross-contamination)', async () => {
    // Three completed jobs in one sweep — exercises the batched findByJobs +
    // group-by-job path. jobA: billable, no invoice → included. jobB: billable
    // but already invoiced → excluded. jobC: billable, distinct amount →
    // included. A grouping bug (mixing one job's invoice/estimate into another)
    // would mis-include B or mis-total A/C.
    const jobA = await jobRepo.create(makeJob({ jobNumber: 'JOB-A' }));
    const jobB = await jobRepo.create(makeJob({ jobNumber: 'JOB-B' }));
    const jobC = await jobRepo.create(makeJob({ jobNumber: 'JOB-C' }));

    await seedAcceptedEstimate(jobA.id, [buildLineItem('a1', 'A work', 1, 20000, 0, true)]);
    await seedAcceptedEstimate(jobB.id, [buildLineItem('b1', 'B work', 1, 30000, 0, true)]);
    await seedAcceptedEstimate(jobC.id, [buildLineItem('c1', 'C work', 1, 45000, 0, true)]);

    // Only jobB has a live invoice.
    await createInvoice(
      { tenantId: TENANT, jobId: jobB.id, invoiceNumber: 'INV-B', lineItems: [buildLineItem('b1', 'B work', 1, 30000, 0, true)], createdBy: 'u1' },
      invoiceRepo,
    );

    const candidates = await findJobsRequiringInvoicing(TENANT, deps());
    const byJob = new Map(candidates.map((c) => [c.jobId, c]));
    expect(byJob.has(jobB.id)).toBe(false); // already invoiced
    expect(byJob.get(jobA.id)?.amountCents).toBe(20000);
    expect(byJob.get(jobC.id)?.amountCents).toBe(45000);
    expect(candidates).toHaveLength(2);
  });
});
