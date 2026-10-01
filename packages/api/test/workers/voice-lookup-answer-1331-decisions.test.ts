/**
 * #1331 owner decisions (2026-10-01) on the shared lookup answers — the
 * phone and in-app surfaces both speak `executeLookupAnswer`'s summary:
 *   - "your jobs" names up to 3 recent jobs, newest first (not only the latest);
 *   - estimate lookups say each estimate's date;
 *   - "confirm my info" keeps the phone number MASKED (privacy posture).
 */
import { describe, it, expect } from 'vitest';
import { executeLookupAnswer } from '../../src/workers/voice-lookup-answer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import type { Job } from '../../src/jobs/job';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import type { Estimate } from '../../src/estimates/estimate';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import type { Customer } from '../../src/customers/customer';

const TENANT = 'tenant-1331';
const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-05-01T17:00:00.000Z');
const CUSTOMER = '00000000-0000-4000-8000-000001030001';

function makeJob(over: Partial<Job>): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: TENANT,
    customerId: CUSTOMER,
    locationId: 'loc-1',
    jobNumber: 'JOB-0000',
    summary: 'Untitled job',
    status: 'scheduled',
    priority: 'normal',
    createdBy: 'u1',
    createdAt: new Date('2026-04-01T08:00:00.000Z'),
    updatedAt: new Date('2026-04-01T08:00:00.000Z'),
    ...over,
  } as Job;
}

async function speak(
  intent: 'lookup_jobs' | 'lookup_estimates' | 'lookup_customer',
  deps: Parameters<typeof executeLookupAnswer>[1],
  shared: Omit<Parameters<typeof executeLookupAnswer>[2], 'proposalRepo'>,
): Promise<string> {
  const execution = await executeLookupAnswer(
    { tenantId: TENANT, sessionId: 'sess-1331', intent, customerId: CUSTOMER, timezone: TZ, now: NOW },
    deps,
    { proposalRepo: new InMemoryProposalRepository(), ...shared },
  );
  if (execution.kind !== 'answer') throw new Error(`expected an answer, got ${JSON.stringify(execution)}`);
  return execution.answer.summary;
}

describe('#1331 decision — "your jobs" lists up to 3 recent jobs, newest first', () => {
  it("names both of a customer's two jobs, the newest first", async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(makeJob({
      jobNumber: 'JOB-2001', summary: 'Furnace replacement', status: 'in_progress',
      createdAt: new Date('2026-04-10T08:00:00.000Z'),
    }));
    await jobRepo.create(makeJob({
      jobNumber: 'JOB-2002', summary: 'Annual maintenance', status: 'new',
      createdAt: new Date('2026-04-28T08:00:00.000Z'),
    }));

    const summary = await speak('lookup_jobs', {}, { jobRepo });

    expect(summary).toContain('JOB-2002');
    expect(summary).toContain('Annual maintenance');
    expect(summary).toContain('JOB-2001');
    expect(summary).toContain('Furnace replacement');
    expect(summary).toMatch(/in progress/);
    expect(summary.indexOf('JOB-2002')).toBeLessThan(summary.indexOf('JOB-2001'));
  });
});

function makeEstimate(over: Partial<Estimate>): Estimate {
  return {
    id: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    tenantId: TENANT,
    jobId: 'job-est',
    estimateNumber: 'EST-0000',
    status: 'sent',
    lineItems: [],
    totals: { subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0, taxRateBps: 0, taxableSubtotalCents: 0 },
    version: 1,
    createdBy: 'u1',
    createdAt: new Date('2026-04-01T10:00:00.000Z'),
    updatedAt: new Date('2026-04-01T10:00:00.000Z'),
    ...over,
  } as Estimate;
}

describe("#1331 decision — estimate lookups say each estimate's date", () => {
  it('a single sent estimate is read back with the day it was sent', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(makeJob({ id: 'job-est', jobNumber: 'JOB-EST-1', summary: 'Thermostat' }));
    const estimateRepo = new InMemoryEstimateRepository();
    await estimateRepo.create(makeEstimate({
      estimateNumber: 'EST-4001',
      totals: { subtotalCents: 35000, discountCents: 0, taxCents: 2800, totalCents: 37800, taxRateBps: 0, taxableSubtotalCents: 35000 },
      sentAt: new Date('2026-04-22T17:00:00.000Z'),
      createdAt: new Date('2026-04-20T17:00:00.000Z'),
    }));

    const summary = await speak('lookup_estimates', { estimateRepo }, { jobRepo });

    expect(summary).toContain('EST-4001');
    expect(summary).toContain('$378');
    expect(summary).toMatch(/sent on April 22/);
  });

  it('several estimates are each read back with their own date, newest first', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(makeJob({ id: 'job-est', jobNumber: 'JOB-EST-1', summary: 'Thermostat' }));
    const estimateRepo = new InMemoryEstimateRepository();
    await estimateRepo.create(makeEstimate({
      estimateNumber: 'EST-4001',
      totals: { subtotalCents: 37800, discountCents: 0, taxCents: 0, totalCents: 37800, taxRateBps: 0, taxableSubtotalCents: 37800 },
      sentAt: new Date('2026-04-22T17:00:00.000Z'),
    }));
    await estimateRepo.create(makeEstimate({
      estimateNumber: 'EST-4002',
      status: 'draft',
      totals: { subtotalCents: 12000, discountCents: 0, taxCents: 0, totalCents: 12000, taxRateBps: 0, taxableSubtotalCents: 12000 },
      createdAt: new Date('2026-04-27T17:00:00.000Z'),
    }));

    const summary = await speak('lookup_estimates', { estimateRepo }, { jobRepo });

    expect(summary).toMatch(/EST-4002[^;]*April 27/);
    expect(summary).toMatch(/EST-4001[^;]*sent on April 22/);
    expect(summary.indexOf('EST-4002')).toBeLessThan(summary.indexOf('EST-4001'));
  });
});

describe('#1331 decision — "confirm my info" keeps the phone number masked (privacy)', () => {
  it('reads back the name and only the last four digits of the number on file', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    await customerRepo.create({
      id: CUSTOMER,
      tenantId: TENANT,
      firstName: 'Carlos',
      lastName: 'Rivera',
      displayName: 'Carlos Rivera',
      primaryPhone: '+15555550102',
      email: 'carlos.rivera@example.com',
      preferredChannel: 'phone',
      smsConsent: true,
      isArchived: false,
      createdBy: 'user_seed',
      createdAt: new Date('2026-02-10T09:00:00.000Z'),
      updatedAt: new Date('2026-04-01T09:00:00.000Z'),
    } as Customer);

    const summary = await speak('lookup_customer', {}, { customerRepo });

    expect(summary).toContain('Carlos Rivera');
    expect(summary).toContain('ending in 0102');
    expect(summary).not.toMatch(/555.?555.?0102/);
  });
});
