import { describe, it, expect, beforeEach } from 'vitest';
import { createJob, InMemoryJobRepository, MAX_JOB_LIMIT } from '../../src/jobs/job';

describe('Task 10 quality-review C2 — JobRepository.findByIds', () => {
  let repo: InMemoryJobRepository;

  beforeEach(() => {
    repo = new InMemoryJobRepository();
  });

  async function seedJob(opts: { tenantId?: string; summary?: string; createdAt?: Date }) {
    const job = await createJob(
      {
        tenantId: opts.tenantId ?? 'tenant-1',
        customerId: 'cust-1',
        locationId: 'loc-1',
        summary: opts.summary ?? 'Test',
        createdBy: 'user-1',
      },
      repo,
    );
    if (opts.createdAt) {
      await repo.update(job.tenantId, job.id, { createdAt: opts.createdAt } as never);
    }
    return job;
  }

  it('happy path — returns exactly the requested jobs, tenant-scoped', async () => {
    const a = await seedJob({ summary: 'a' });
    const b = await seedJob({ summary: 'b' });
    await seedJob({ summary: 'c' }); // not requested

    const result = await repo.findByIds('tenant-1', [a.id, b.id]);

    expect(result.map((j) => j.summary).sort()).toEqual(['a', 'b']);
  });

  it('tenant isolation — never returns a job from a different tenant even if the id matches', async () => {
    const foreign = await seedJob({ tenantId: 'tenant-2', summary: 'theirs' });

    const result = await repo.findByIds('tenant-1', [foreign.id]);

    expect(result).toEqual([]);
  });

  it('empty ids array — returns [] without touching the store', async () => {
    await seedJob({ summary: 'irrelevant' });
    const result = await repo.findByIds('tenant-1', []);
    expect(result).toEqual([]);
  });

  it('unknown id — silently omitted, never throws', async () => {
    const real = await seedJob({ summary: 'real' });
    const result = await repo.findByIds('tenant-1', [real.id, 'does-not-exist']);
    expect(result.map((j) => j.summary)).toEqual(['real']);
  });

  // The exact regression the review reproduced: a job created LONG before
  // MAX_JOB_LIMIT (200) more-recent jobs, which `findByTenant({ limit:
  // MAX_JOB_LIMIT })` would silently drop (createdAt DESC + slice). A
  // caller that already knows the id (e.g. from today's appointments)
  // must get it back regardless of how many newer jobs exist.
  it('returns a job that would fall off a findByTenant({ limit: MAX_JOB_LIMIT }) page', async () => {
    // Explicit, strictly increasing createdAt stamps — a tight loop of
    // `new Date()` calls can tie at millisecond resolution, and a stable
    // sort on a tie preserves INSERTION order (old-first) rather than the
    // true recency order this test needs to exercise.
    const old = await seedJob({
      summary: 'old job with a live appointment today',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newerBase = new Date('2026-06-01T00:00:00.000Z').getTime();
    for (let i = 0; i < MAX_JOB_LIMIT + 50; i++) {
      await seedJob({
        summary: `newer-${i}`,
        createdAt: new Date(newerBase + i * 1000),
      });
    }

    // Sanity check: the old job really is NOT on the recency-limited page.
    const page = await repo.findByTenant('tenant-1', { limit: MAX_JOB_LIMIT });
    expect(page.find((j) => j.id === old.id)).toBeUndefined();

    // findByIds is unaffected by recency — it's not a page at all.
    const byIds = await repo.findByIds('tenant-1', [old.id]);
    expect(byIds.map((j) => j.summary)).toEqual(['old job with a live appointment today']);
  });
});
