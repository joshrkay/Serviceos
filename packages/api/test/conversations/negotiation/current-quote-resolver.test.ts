/**
 * Unit tests for the current-quote resolver
 * (src/conversations/negotiation/current-quote-resolver.ts).
 *
 * Two layers:
 *   1. selectCurrentQuoteEstimate — the pure status-filter + most-recent pick,
 *      exercised without any repo.
 *   2. DefaultCurrentQuoteResolver.resolve — wired against in-memory stub repos
 *      (no real DB): confirms it returns the quote + grounding for a live
 *      estimate, fails safe to null on the empty / no-live / thrown-error paths,
 *      and that grounding reflects isEstimateCatalogGrounded.
 */
import { describe, it, expect } from 'vitest';
import {
  selectCurrentQuoteEstimate,
  DefaultCurrentQuoteResolver,
} from '../../../src/conversations/negotiation/current-quote-resolver';
import {
  Estimate,
  EstimateRepository,
  EstimateStatus,
} from '../../../src/estimates/estimate';
import { Job, JobRepository, JobFindByCustomerOptions } from '../../../src/jobs/job';
import { LineItem } from '../../../src/shared/billing-engine';

const TENANT = 'tenant-1';
const CUSTOMER = 'customer-1';

// --- fixtures --------------------------------------------------------------

function lineItem(overrides: Partial<LineItem> = {}): LineItem {
  return {
    id: 'li-1',
    description: 'Service',
    quantity: 1,
    unitPriceCents: 20000,
    totalCents: 20000,
    sortOrder: 0,
    taxable: true,
    pricingSource: 'catalog',
    ...overrides,
  };
}

function estimate(overrides: Partial<Estimate> = {}): Estimate {
  const totalCents = overrides.totals?.totalCents ?? 20000;
  return {
    id: 'est-1',
    tenantId: TENANT,
    jobId: 'job-1',
    estimateNumber: 'EST-0001',
    status: 'sent',
    lineItems: [lineItem()],
    totals: {
      subtotalCents: totalCents,
      discountCents: 0,
      taxRateBps: 0,
      taxableSubtotalCents: totalCents,
      taxCents: 0,
      totalCents,
    },
    version: 1,
    createdBy: 'user-1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function job(id: string): Job {
  return {
    id,
    tenantId: TENANT,
    customerId: CUSTOMER,
    locationId: 'loc-1',
    jobNumber: `JOB-${id}`,
    summary: 'Job',
    status: 'new',
    priority: 'normal',
    createdBy: 'user-1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
  };
}

/** Minimal stub job repo exposing only findByCustomer (the path we exercise). */
function stubJobRepo(
  findByCustomer: (
    tenantId: string,
    customerId: string,
    opts?: JobFindByCustomerOptions,
  ) => Promise<Job[]>,
): JobRepository {
  return { findByCustomer } as unknown as JobRepository;
}

/** Minimal stub estimate repo exposing only findByJobs. */
function stubEstimateRepo(
  findByJobs: (tenantId: string, jobIds: string[]) => Promise<Estimate[]>,
): EstimateRepository {
  return { findByJobs } as unknown as EstimateRepository;
}

// --- selectCurrentQuoteEstimate (pure) -------------------------------------

describe('selectCurrentQuoteEstimate', () => {
  it('returns null for an empty list', () => {
    expect(selectCurrentQuoteEstimate([])).toBeNull();
  });

  it('picks the most-recent (by updatedAt) sent estimate', () => {
    const older = estimate({
      id: 'older',
      status: 'sent',
      updatedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const newer = estimate({
      id: 'newer',
      status: 'sent',
      updatedAt: new Date('2026-06-10T00:00:00Z'),
    });
    expect(selectCurrentQuoteEstimate([older, newer])?.id).toBe('newer');
    // Order-independent.
    expect(selectCurrentQuoteEstimate([newer, older])?.id).toBe('newer');
  });

  it('treats accepted estimates as live quotes', () => {
    const accepted = estimate({ id: 'acc', status: 'accepted' });
    expect(selectCurrentQuoteEstimate([accepted])?.id).toBe('acc');
  });

  it('picks the most-recent across mixed sent/accepted', () => {
    const sent = estimate({
      id: 'sent',
      status: 'sent',
      updatedAt: new Date('2026-06-05T00:00:00Z'),
    });
    const accepted = estimate({
      id: 'accepted',
      status: 'accepted',
      updatedAt: new Date('2026-06-09T00:00:00Z'),
    });
    expect(selectCurrentQuoteEstimate([sent, accepted])?.id).toBe('accepted');
  });

  it('ignores draft / rejected / expired estimates', () => {
    const ignored: EstimateStatus[] = ['draft', 'ready_for_review', 'rejected', 'expired'];
    const estimates = ignored.map((status, i) =>
      estimate({ id: `e-${status}`, status, updatedAt: new Date(2026, 5, 20 + i) }),
    );
    expect(selectCurrentQuoteEstimate(estimates)).toBeNull();
  });

  it('returns null when only non-live estimates accompany no live ones', () => {
    const draft = estimate({ id: 'draft', status: 'draft' });
    const rejected = estimate({ id: 'rejected', status: 'rejected' });
    expect(selectCurrentQuoteEstimate([draft, rejected])).toBeNull();
  });

  it('selects the only live estimate even when a more-recent non-live one exists', () => {
    const liveOld = estimate({
      id: 'live-old',
      status: 'sent',
      updatedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const draftNew = estimate({
      id: 'draft-new',
      status: 'draft',
      updatedAt: new Date('2026-06-30T00:00:00Z'),
    });
    expect(selectCurrentQuoteEstimate([liveOld, draftNew])?.id).toBe('live-old');
  });

  it('falls back to createdAt when updatedAt is absent (tie-break)', () => {
    const a = estimate({
      id: 'a',
      status: 'sent',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: undefined as unknown as Date,
    });
    const b = estimate({
      id: 'b',
      status: 'sent',
      createdAt: new Date('2026-06-08T00:00:00Z'),
      updatedAt: undefined as unknown as Date,
    });
    expect(selectCurrentQuoteEstimate([a, b])?.id).toBe('b');
  });
});

// --- DefaultCurrentQuoteResolver.resolve -----------------------------------

describe('DefaultCurrentQuoteResolver.resolve', () => {
  it('returns the quote + grounding for a sent, catalog-grounded estimate', async () => {
    const jobRepo = stubJobRepo(async () => [job('job-1')]);
    const estimateRepo = stubEstimateRepo(async () => [
      estimate({ id: 'est-1', jobId: 'job-1', status: 'sent' }),
    ]);
    const resolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });

    const result = await resolver.resolve(TENANT, CUSTOMER);

    expect(result).toEqual({
      estimateId: 'est-1',
      quotedCents: 20000,
      catalogGrounded: true,
    });
  });

  it('passes the resolved jobIds through to findByJobs', async () => {
    let seenJobIds: string[] | undefined;
    const jobRepo = stubJobRepo(async () => [job('job-1'), job('job-2')]);
    const estimateRepo = stubEstimateRepo(async (_tenant, jobIds) => {
      seenJobIds = jobIds;
      return [estimate({ id: 'est-1', jobId: 'job-2', status: 'sent' })];
    });
    const resolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });

    await resolver.resolve(TENANT, CUSTOMER);

    expect(seenJobIds).toEqual(['job-1', 'job-2']);
  });

  it('reflects NOT catalog-grounded when a priced line is uncatalogued', async () => {
    const jobRepo = stubJobRepo(async () => [job('job-1')]);
    const estimateRepo = stubEstimateRepo(async () => [
      estimate({
        id: 'est-1',
        status: 'sent',
        lineItems: [lineItem({ pricingSource: 'uncatalogued' })],
      }),
    ]);
    const resolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });

    const result = await resolver.resolve(TENANT, CUSTOMER);

    expect(result?.catalogGrounded).toBe(false);
    expect(result?.quotedCents).toBe(20000);
  });

  it('returns null when the customer has no jobs', async () => {
    const jobRepo = stubJobRepo(async () => []);
    const estimateRepo = stubEstimateRepo(async () => {
      throw new Error('findByJobs should not be called when there are no jobs');
    });
    const resolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });

    expect(await resolver.resolve(TENANT, CUSTOMER)).toBeNull();
  });

  it('returns null when there are jobs but no sent/accepted estimate', async () => {
    const jobRepo = stubJobRepo(async () => [job('job-1')]);
    const estimateRepo = stubEstimateRepo(async () => [
      estimate({ id: 'draft', status: 'draft' }),
      estimate({ id: 'rejected', status: 'rejected' }),
    ]);
    const resolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });

    expect(await resolver.resolve(TENANT, CUSTOMER)).toBeNull();
  });

  it('returns null when the live estimate total is not positive', async () => {
    const jobRepo = stubJobRepo(async () => [job('job-1')]);
    const estimateRepo = stubEstimateRepo(async () => [
      estimate({
        id: 'zero',
        status: 'sent',
        totals: {
          subtotalCents: 0,
          discountCents: 0,
          taxRateBps: 0,
          taxableSubtotalCents: 0,
          taxCents: 0,
          totalCents: 0,
        },
      }),
    ]);
    const resolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });

    expect(await resolver.resolve(TENANT, CUSTOMER)).toBeNull();
  });

  it('returns null (does not throw) when the job repo throws', async () => {
    const jobRepo = stubJobRepo(async () => {
      throw new Error('db down');
    });
    const estimateRepo = stubEstimateRepo(async () => []);
    const resolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });

    await expect(resolver.resolve(TENANT, CUSTOMER)).resolves.toBeNull();
  });

  it('returns null (does not throw) when the estimate repo throws', async () => {
    const jobRepo = stubJobRepo(async () => [job('job-1')]);
    const estimateRepo = stubEstimateRepo(async () => {
      throw new Error('db down');
    });
    const resolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });

    await expect(resolver.resolve(TENANT, CUSTOMER)).resolves.toBeNull();
  });

  it('returns null when the repo does not implement findByCustomer', async () => {
    const jobRepo = {} as unknown as JobRepository;
    const estimateRepo = stubEstimateRepo(async () => []);
    const resolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });

    expect(await resolver.resolve(TENANT, CUSTOMER)).toBeNull();
  });

  it('returns null when customerId is empty', async () => {
    const jobRepo = stubJobRepo(async () => [job('job-1')]);
    const estimateRepo = stubEstimateRepo(async () => [estimate()]);
    const resolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });

    expect(await resolver.resolve(TENANT, '')).toBeNull();
  });
});
