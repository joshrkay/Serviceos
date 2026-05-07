import { describe, it, expect, beforeEach } from 'vitest';
import { lookupEstimates } from '../../../src/ai/skills/lookup-estimates';
import { createJob, InMemoryJobRepository } from '../../../src/jobs/job';
import {
  createEstimate,
  InMemoryEstimateRepository,
} from '../../../src/estimates/estimate';
import { InMemoryLookupEventRepository } from '../../../src/lookup-events/lookup-event';
import { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

describe('VQ-006 — lookupEstimates skill', () => {
  let jobRepo: InMemoryJobRepository;
  let estimateRepo: InMemoryEstimateRepository;
  let lookupRepo: InMemoryLookupEventRepository;
  let lookupEvents: LookupEventService;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    estimateRepo = new InMemoryEstimateRepository();
    lookupRepo = new InMemoryLookupEventRepository();
    lookupEvents = new LookupEventService(lookupRepo);
  });

  async function seedEstimateForCustomer(opts: {
    tenantId?: string;
    customerId?: string;
    estimateNumber: string;
    totalCents: number;
  }) {
    const job = await createJob(
      {
        tenantId: opts.tenantId ?? 'tenant-1',
        customerId: opts.customerId ?? 'cust-1',
        locationId: 'loc-1',
        summary: 'AC repair',
        createdBy: 'u-1',
      },
      jobRepo,
    );
    return createEstimate(
      {
        tenantId: job.tenantId,
        jobId: job.id,
        estimateNumber: opts.estimateNumber,
        lineItems: [
          {
            id: 'li-1',
            description: 'Service',
            quantity: 1,
            unitPriceCents: opts.totalCents,
            totalCents: opts.totalCents,
            sortOrder: 0,
            taxable: false,
          },
        ],
        createdBy: 'u-1',
      },
      estimateRepo,
    );
  }

  it('VQ-006 — happy path: returns customer estimates', async () => {
    await seedEstimateForCustomer({
      estimateNumber: 'EST-1001',
      totalCents: 25000,
    });

    const result = await lookupEstimates(
      { tenantId: 'tenant-1', customerId: 'cust-1' },
      { jobRepo, estimateRepo, lookupEvents },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.data.estimates).toHaveLength(1);
    expect(result.data.estimates[0].estimateNumber).toBe('EST-1001');
    expect(result.data.count).toBe(1);
    expect(result.data.totalCents).toBe(25000);
  });

  it('VQ-006 — empty: customer has no estimates returns empty list', async () => {
    const result = await lookupEstimates(
      { tenantId: 'tenant-1', customerId: 'cust-empty' },
      { jobRepo, estimateRepo, lookupEvents },
    );

    expect(result.status).toBe('none');
    if (result.status !== 'none') return;
    expect(result.data.estimates).toEqual([]);
    expect(result.data.count).toBe(0);
  });

  it('VQ-006 — tenant isolation: estimates for tenant A invisible from tenant B', async () => {
    await seedEstimateForCustomer({
      tenantId: 'tenant-A',
      customerId: 'cust-shared',
      estimateNumber: 'EST-A',
      totalCents: 10000,
    });

    const result = await lookupEstimates(
      { tenantId: 'tenant-B', customerId: 'cust-shared' },
      { jobRepo, estimateRepo, lookupEvents },
    );

    expect(result.status).toBe('none');
  });

  it('VQ-006 — only includes the requested customer estimates', async () => {
    await seedEstimateForCustomer({
      customerId: 'cust-1',
      estimateNumber: 'EST-1',
      totalCents: 10000,
    });
    await seedEstimateForCustomer({
      customerId: 'cust-2',
      estimateNumber: 'EST-2',
      totalCents: 99999,
    });

    const result = await lookupEstimates(
      { tenantId: 'tenant-1', customerId: 'cust-1' },
      { jobRepo, estimateRepo, lookupEvents },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.data.estimates).toHaveLength(1);
    expect(result.data.estimates[0].estimateNumber).toBe('EST-1');
  });

  it('VQ-006 — audit: writes a lookup_events row on each invocation', async () => {
    await lookupEstimates(
      { tenantId: 'tenant-1', customerId: 'cust-1', sessionId: 'sess-7' },
      { jobRepo, estimateRepo, lookupEvents },
    );

    const rows = await lookupRepo.listByTenant('tenant-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].intent).toBe('lookup_estimates');
    expect(rows[0].sessionId).toBe('sess-7');
  });
});
