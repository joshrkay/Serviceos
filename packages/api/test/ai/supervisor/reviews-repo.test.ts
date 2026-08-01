/**
 * WS6 — InMemorySupervisorReviewRepository.findForDay window behavior.
 * Pins the half-open [from, to) window, tenant isolation, newest-first
 * ordering, and the limit cap — the same contract the digest builder
 * (digest-service.ts) relies on, mirroring how
 * ProposalRepository.findConfidenceMarkedForDay is exercised.
 */
import { describe, it, expect } from 'vitest';
import { InMemorySupervisorReviewRepository } from '../../../src/ai/supervisor/reviews-repo';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

async function seed(
  repo: InMemorySupervisorReviewRepository,
  tenantId: string,
  proposalId: string,
): Promise<void> {
  await repo.create({
    tenantId,
    proposalId,
    model: 'm',
    verdict: 'pass',
    critical: false,
    checks: {},
    flags: [],
    shadow: true,
  });
}

/**
 * Pin a row's `createdAt` after the fact. `create()` has no injectable
 * clock, so boundary-precision tests reach into the repo's internal store
 * directly (a legitimate technique for an in-memory test double — the
 * public API only ever hands back clones).
 */
function pinCreatedAt(
  repo: InMemorySupervisorReviewRepository,
  proposalId: string,
  createdAt: Date,
): void {
  const rows = (repo as unknown as { rows: { proposalId: string; createdAt: Date }[] }).rows;
  const row = rows.find((r) => r.proposalId === proposalId);
  if (!row) throw new Error(`no seeded row for ${proposalId}`);
  row.createdAt = createdAt;
}

describe('InMemorySupervisorReviewRepository.findForDay', () => {
  it('includes rows at the `from` boundary, excludes rows at the `to` boundary (half-open window)', async () => {
    const repo = new InMemorySupervisorReviewRepository();
    await seed(repo, TENANT, 'p-before');
    await seed(repo, TENANT, 'p-at-start');
    await seed(repo, TENANT, 'p-inside');
    await seed(repo, TENANT, 'p-at-end');
    await seed(repo, TENANT, 'p-after');

    const from = new Date('2026-06-10T05:00:00.000Z');
    const to = new Date('2026-06-11T05:00:00.000Z');
    pinCreatedAt(repo, 'p-before', new Date('2026-06-10T04:59:59.999Z'));
    pinCreatedAt(repo, 'p-at-start', from); // included — `from` is inclusive
    pinCreatedAt(repo, 'p-inside', new Date('2026-06-10T12:00:00.000Z'));
    pinCreatedAt(repo, 'p-at-end', to); // excluded — `to` is exclusive
    pinCreatedAt(repo, 'p-after', new Date('2026-06-11T05:00:00.001Z'));

    const found = await repo.findForDay(TENANT, from, to);
    expect(found.map((r) => r.proposalId).sort()).toEqual(['p-at-start', 'p-inside']);
  });

  it('filters by tenant, orders newest-first, and respects the limit cap', async () => {
    const repo = new InMemorySupervisorReviewRepository();
    const from = new Date('2026-06-10T00:00:00.000Z');
    const to = new Date('2026-06-11T00:00:00.000Z');

    await seed(repo, TENANT, 'p1');
    await seed(repo, TENANT, 'p2');
    await seed(repo, TENANT, 'p3');
    await seed(repo, OTHER_TENANT, 'p-other');
    pinCreatedAt(repo, 'p1', new Date('2026-06-10T08:00:00.000Z'));
    pinCreatedAt(repo, 'p2', new Date('2026-06-10T10:00:00.000Z'));
    pinCreatedAt(repo, 'p3', new Date('2026-06-10T12:00:00.000Z'));
    pinCreatedAt(repo, 'p-other', new Date('2026-06-10T09:00:00.000Z'));

    const all = await repo.findForDay(TENANT, from, to);
    // Newest first: p3 (12:00) > p2 (10:00) > p1 (08:00).
    expect(all.map((r) => r.proposalId)).toEqual(['p3', 'p2', 'p1']);
    expect(all.every((r) => r.tenantId === TENANT)).toBe(true);

    const capped = await repo.findForDay(TENANT, from, to, 2);
    expect(capped.map((r) => r.proposalId)).toEqual(['p3', 'p2']);

    const otherOnly = await repo.findForDay(OTHER_TENANT, from, to);
    expect(otherOnly.map((r) => r.proposalId)).toEqual(['p-other']);
  });

  it('returns an empty array when no reviews fall inside the window', async () => {
    const repo = new InMemorySupervisorReviewRepository();
    await seed(repo, TENANT, 'p1');
    pinCreatedAt(repo, 'p1', new Date('2026-06-01T00:00:00.000Z'));
    const found = await repo.findForDay(
      TENANT,
      new Date('2026-06-10T00:00:00.000Z'),
      new Date('2026-06-11T00:00:00.000Z'),
    );
    expect(found).toEqual([]);
  });
});
