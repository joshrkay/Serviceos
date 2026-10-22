import { describe, it, expect } from 'vitest';
import { customerJobsForLookup } from '../../../src/ai/skills/customer-jobs';
import { createJob, InMemoryJobRepository } from '../../../src/jobs/job';

const newJob = (repo: InMemoryJobRepository, customerId: string, summary: string) =>
  createJob({ tenantId: 't-1', customerId, locationId: 'loc-1', summary, createdBy: 'u-1' }, repo);

describe('customerJobsForLookup', () => {
  it('reads the job the operator pointed at directly, past the customer list cap', async () => {
    const repo = new InMemoryJobRepository();
    const old = await newJob(repo, 'cust-1', 'Original install');
    await repo.update('t-1', old.id, { createdAt: new Date('2020-01-01T00:00:00Z') });
    for (let i = 0; i < 205; i++) await newJob(repo, 'cust-1', `Visit ${i}`);

    expect((await repo.findByCustomer('t-1', 'cust-1')).some((j) => j.id === old.id)).toBe(false);
    expect(await customerJobsForLookup(repo, 't-1', 'cust-1', old.id)).toEqual([expect.objectContaining({ id: old.id })]);
  });

  it("returns nothing for another customer's job", async () => {
    const repo = new InMemoryJobRepository();
    const theirs = await newJob(repo, 'cust-2', 'Not yours');
    expect(await customerJobsForLookup(repo, 't-1', 'cust-1', theirs.id)).toEqual([]);
  });

  it('lists the customer’s jobs when no job was named', async () => {
    const repo = new InMemoryJobRepository();
    await newJob(repo, 'cust-1', 'A');
    await newJob(repo, 'cust-1', 'B');
    await newJob(repo, 'cust-2', 'C');
    expect((await customerJobsForLookup(repo, 't-1', 'cust-1', undefined)).map((j) => j.summary).sort()).toEqual(['A', 'B']);
  });
});
