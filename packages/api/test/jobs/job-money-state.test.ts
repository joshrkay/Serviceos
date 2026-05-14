import { describe, it, expect } from 'vitest';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';

describe('Job.moneyState field', () => {
  it('createJob defaults moneyState to no_estimate', async () => {
    const repo = new InMemoryJobRepository();
    const job = await createJob(
      {
        tenantId: 't1',
        customerId: 'c1',
        locationId: 'l1',
        summary: 'Fix AC',
        createdBy: 'u1',
      },
      repo,
    );
    expect(job.moneyState).toBe('no_estimate');
  });
});
