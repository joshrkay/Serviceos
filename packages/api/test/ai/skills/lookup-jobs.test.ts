import { describe, it, expect, beforeEach } from 'vitest';
import { lookupJobs } from '../../../src/ai/skills/lookup-jobs';
import { createJob, InMemoryJobRepository } from '../../../src/jobs/job';

describe('P11-001 — lookupJobs skill', () => {
  let jobRepo: InMemoryJobRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
  });

  async function seed(opts: { customerId?: string; tenantId?: string; summary?: string }) {
    return createJob(
      {
        tenantId: opts.tenantId ?? 'tenant-1',
        customerId: opts.customerId ?? 'cust-1',
        locationId: 'loc-1',
        summary: opts.summary ?? 'Job',
        createdBy: 'u-1',
      },
      jobRepo,
    );
  }

  it('happy path — returns most recent jobs and a TTS line', async () => {
    await seed({ summary: 'first' });
    await seed({ summary: 'second' });
    await seed({ summary: 'third' });

    const result = await lookupJobs(
      { tenantId: 'tenant-1', customerId: 'cust-1' },
      { jobRepo },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.data.jobs).toHaveLength(3);
    // 3 jobs returned + each summary is mentioned somewhere in the
    // skill output (data carries them all even when the headline only
    // mentions the latest).
    expect(result.summary).toContain('3 recent jobs');
    expect(result.data.jobs.map((j) => j.summary).sort()).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('none — when customer has no jobs', async () => {
    const result = await lookupJobs(
      { tenantId: 'tenant-1', customerId: 'cust-empty' },
      { jobRepo },
    );
    expect(result.status).toBe('none');
  });

  it('tenant isolation — never returns another tenant jobs', async () => {
    await seed({ tenantId: 'tenant-2', customerId: 'cust-shared', summary: 'leaked' });
    const result = await lookupJobs(
      { tenantId: 'tenant-1', customerId: 'cust-shared' },
      { jobRepo },
    );
    expect(result.status).toBe('none');
  });

  it('respects recentLimit', async () => {
    for (let i = 0; i < 5; i++) await seed({ summary: `j${i}` });
    const result = await lookupJobs(
      { tenantId: 'tenant-1', customerId: 'cust-1', recentLimit: 2 },
      { jobRepo },
    );
    if (result.status !== 'found') throw new Error('expected found');
    expect(result.data.jobs).toHaveLength(2);
  });
});
