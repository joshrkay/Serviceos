import { describe, it, expect, beforeEach, vi } from 'vitest';
import { lookupJobs } from '../../../src/ai/skills/lookup-jobs';
import {
  createJob,
  InMemoryJobRepository,
  type Job,
  type JobRepository,
} from '../../../src/jobs/job';
import { InMemoryLookupEventRepository } from '../../../src/lookup-events/lookup-event';
import { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

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

  // ============================================================
  // P18-004 — isolated unit tests for lookup_jobs
  // ============================================================

  describe('P18-004 lookup_jobs — TTS / tenant isolation / repo wiring', () => {
    it('P18-004 lookup-jobs single result — TTS uses singular "Your most recent job"', async () => {
      await seed({ summary: 'AC tune-up' });
      const result = await lookupJobs(
        { tenantId: 'tenant-1', customerId: 'cust-1' },
        { jobRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.summary).toContain('Your most recent job');
      expect(result.summary).toContain('AC tune-up');
    });

    it('P18-004 lookup-jobs multi result — TTS lists count and latest detail', async () => {
      await seed({ summary: 'a' });
      await seed({ summary: 'b' });
      await seed({ summary: 'c' });
      const result = await lookupJobs(
        { tenantId: 'tenant-1', customerId: 'cust-1' },
        { jobRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.summary).toMatch(/3 recent jobs/);
      expect(result.summary.toLowerCase()).toContain('latest');
    });

    it('P18-004 lookup-jobs empty — TTS uses friendly "not seeing any jobs" phrasing', async () => {
      const result = await lookupJobs(
        { tenantId: 'tenant-1', customerId: 'no-such' },
        { jobRepo },
      );
      expect(result.status).toBe('none');
      expect(result.summary.toLowerCase()).toContain('not seeing any jobs');
    });

    it('P18-004 lookup-jobs tenant isolation — tenant A jobs invisible to tenant B caller', async () => {
      await seed({ tenantId: 'tenant-A', customerId: 'cust-shared', summary: 'A-job' });
      await seed({ tenantId: 'tenant-B', customerId: 'cust-shared', summary: 'B-job' });

      const result = await lookupJobs(
        { tenantId: 'tenant-B', customerId: 'cust-shared' },
        { jobRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.data.jobs).toHaveLength(1);
      expect(result.data.jobs[0].summary).toBe('B-job');
    });

    it('P18-004 lookup-jobs cross-customer leak — customer A scope returns only A jobs', async () => {
      await seed({ customerId: 'cust-A', summary: 'A-only' });
      await seed({ customerId: 'cust-B', summary: 'B-only' });
      const result = await lookupJobs(
        { tenantId: 'tenant-1', customerId: 'cust-A' },
        { jobRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.data.jobs.map((j) => j.summary)).toEqual(['A-only']);
    });

    it('P18-004 lookup-jobs repo wiring — JobRepository.findByCustomer is called with tenantId first arg', async () => {
      const findByCustomer = vi.fn(async (_tenantId: string, _customerId: string) => [] as Job[]);
      const stubbed = jobRepo as unknown as JobRepository;
      stubbed.findByCustomer = findByCustomer;
      await lookupJobs(
        { tenantId: 'tenant-Z', customerId: 'cust-Q' },
        { jobRepo: stubbed },
      );
      expect(findByCustomer).toHaveBeenCalled();
      const call = findByCustomer.mock.calls[0];
      if (!call) throw new Error('expected call');
      expect(call[0]).toBe('tenant-Z');
      expect(call[1]).toBe('cust-Q');
    });

    it('P18-004 lookup-jobs no ISO timestamps in summary', async () => {
      await seed({ summary: 'thing' });
      const result = await lookupJobs(
        { tenantId: 'tenant-1', customerId: 'cust-1' },
        { jobRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.summary).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('P18-004 lookup-jobs repo throws — returns status=error with friendly summary', async () => {
      const findByCustomer = vi.fn(async () => {
        throw new Error('db down');
      });
      const stubbed = jobRepo as unknown as JobRepository;
      stubbed.findByCustomer = findByCustomer;
      const result = await lookupJobs(
        { tenantId: 'tenant-1', customerId: 'cust-1' },
        { jobRepo: stubbed },
      );
      expect(result.status).toBe('error');
      expect(result.summary.toLowerCase()).toContain('trouble');
    });

    it('P18-004 lookup-jobs missing findByCustomer — returns status=error', async () => {
      const stubbed = jobRepo as unknown as JobRepository;
      stubbed.findByCustomer = undefined;
      const result = await lookupJobs(
        { tenantId: 'tenant-1', customerId: 'cust-1' },
        { jobRepo: stubbed },
      );
      expect(result.status).toBe('error');
    });

    it('P18-004 lookup-jobs pagination cap — recentLimit honored even with many jobs', async () => {
      for (let i = 0; i < 10; i++) await seed({ summary: `j${i}` });
      const result = await lookupJobs(
        { tenantId: 'tenant-1', customerId: 'cust-1', recentLimit: 3 },
        { jobRepo },
      );
      if (result.status !== 'found') throw new Error('expected found');
      expect(result.data.jobs).toHaveLength(3);
    });

    it('P18-004 lookup-jobs audit row — records lookup_jobs intent', async () => {
      await seed({ summary: 'work' });
      const lookupRepo = new InMemoryLookupEventRepository();
      const lookupEvents = new LookupEventService(lookupRepo);
      await lookupJobs(
        { tenantId: 'tenant-1', customerId: 'cust-1', sessionId: 'sess-1' },
        { jobRepo, lookupEvents },
      );
      const rows = await lookupRepo.listByTenant('tenant-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].intent).toBe('lookup_jobs');
    });

    it('P18-004 lookup-jobs performance smoke — completes well under 500ms', async () => {
      for (let i = 0; i < 5; i++) await seed({ summary: `j${i}` });
      const t0 = Date.now();
      const result = await lookupJobs(
        { tenantId: 'tenant-1', customerId: 'cust-1' },
        { jobRepo },
      );
      const elapsed = Date.now() - t0;
      expect(result.status).toBe('found');
      expect(elapsed).toBeLessThan(500);
    });
  });
});
