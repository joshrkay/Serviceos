import { describe, it, expect, beforeEach } from 'vitest';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';

describe('P11-001 — JobRepository.findByCustomer', () => {
  let repo: InMemoryJobRepository;

  beforeEach(() => {
    repo = new InMemoryJobRepository();
  });

  async function seedJob(opts: {
    tenantId?: string;
    customerId?: string;
    summary?: string;
    status?: 'new' | 'scheduled' | 'in_progress' | 'completed' | 'canceled';
  }) {
    const job = await createJob(
      {
        tenantId: opts.tenantId ?? 'tenant-1',
        customerId: opts.customerId ?? 'cust-1',
        locationId: 'loc-1',
        summary: opts.summary ?? 'Test',
        createdBy: 'user-1',
      },
      repo,
    );
    if (opts.status && opts.status !== 'new') {
      await repo.update(job.tenantId, job.id, { status: opts.status });
    }
    return job;
  }

  it('happy path — returns only jobs for the requested customer + tenant', async () => {
    await seedJob({ customerId: 'cust-1', summary: 'one' });
    await seedJob({ customerId: 'cust-1', summary: 'two' });
    await seedJob({ customerId: 'cust-2', summary: 'other-customer' });

    const result = await repo.findByCustomer('tenant-1', 'cust-1');

    expect(result).toHaveLength(2);
    expect(result.every((j) => j.customerId === 'cust-1')).toBe(true);
    expect(result.map((j) => j.summary).sort()).toEqual(['one', 'two']);
  });

  it('tenant isolation — never leaks rows from a different tenant', async () => {
    await seedJob({ tenantId: 'tenant-1', customerId: 'cust-shared', summary: 'mine' });
    await seedJob({ tenantId: 'tenant-2', customerId: 'cust-shared', summary: 'theirs' });

    const result = await repo.findByCustomer('tenant-1', 'cust-shared');

    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('mine');
  });

  it('default — excludes canceled jobs', async () => {
    await seedJob({ summary: 'open' });
    await seedJob({ summary: 'killed', status: 'canceled' });

    const result = await repo.findByCustomer('tenant-1', 'cust-1');

    expect(result.map((j) => j.summary)).toEqual(['open']);
  });

  it('includeArchived — returns canceled jobs when requested', async () => {
    await seedJob({ summary: 'open' });
    await seedJob({ summary: 'killed', status: 'canceled' });

    const result = await repo.findByCustomer('tenant-1', 'cust-1', { includeArchived: true });

    expect(result.map((j) => j.summary).sort()).toEqual(['killed', 'open']);
  });

  it('limit — caps the row count', async () => {
    for (let i = 0; i < 5; i++) {
      await seedJob({ summary: `job-${i}` });
    }

    const result = await repo.findByCustomer('tenant-1', 'cust-1', { limit: 2 });

    expect(result).toHaveLength(2);
  });

  it('empty — returns [] for a customer with no jobs', async () => {
    const result = await repo.findByCustomer('tenant-1', 'cust-nope');
    expect(result).toEqual([]);
  });
});
