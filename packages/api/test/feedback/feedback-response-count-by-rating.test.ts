/**
 * E5 U1 — feedback rating aggregate (in-memory) + pure derive helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  InMemoryFeedbackResponseRepository,
  createFeedbackResponse,
  totalResponses,
  averageRating,
  lowRatingCount,
} from '../../src/feedback/feedback-response';

const TENANT = 'tenant-1';
const OTHER = 'tenant-2';
const start = new Date('2026-06-14T00:00:00.000Z');
const end = new Date('2026-06-15T00:00:00.000Z');

async function seed(
  repo: InMemoryFeedbackResponseRepository,
  rows: Array<{ tenantId?: string; rating: number; submittedAt: string }>,
): Promise<void> {
  for (const r of rows) {
    const response = createFeedbackResponse({
      tenantId: r.tenantId ?? TENANT,
      requestId: `req-${Math.random()}`,
      jobId: 'job-1',
      rating: r.rating,
    });
    response.submittedAt = new Date(r.submittedAt);
    await repo.create(response);
  }
}

describe('countByRatingInRange (in-memory)', () => {
  it('counts per-star within the half-open window', async () => {
    const repo = new InMemoryFeedbackResponseRepository();
    await seed(repo, [
      { rating: 5, submittedAt: '2026-06-14T09:00:00.000Z' },
      { rating: 5, submittedAt: '2026-06-14T10:00:00.000Z' },
      { rating: 4, submittedAt: '2026-06-14T11:00:00.000Z' },
      { rating: 2, submittedAt: '2026-06-14T12:00:00.000Z' },
    ]);
    expect(await repo.countByRatingInRange(TENANT, start, end)).toEqual({
      1: 0, 2: 1, 3: 0, 4: 1, 5: 2,
    });
  });

  it('excludes rows outside [start, end) and other tenants', async () => {
    const repo = new InMemoryFeedbackResponseRepository();
    await seed(repo, [
      { rating: 5, submittedAt: '2026-06-13T23:59:59.999Z' }, // before start
      { rating: 1, submittedAt: '2026-06-15T00:00:00.000Z' }, // == end, excluded
      { rating: 5, submittedAt: '2026-06-14T00:00:00.000Z' }, // == start, included
      { tenantId: OTHER, rating: 1, submittedAt: '2026-06-14T08:00:00.000Z' },
    ]);
    expect(await repo.countByRatingInRange(TENANT, start, end)).toEqual({
      1: 0, 2: 0, 3: 0, 4: 0, 5: 1,
    });
  });

  it('returns all-zero counts when there are no responses', async () => {
    const repo = new InMemoryFeedbackResponseRepository();
    expect(await repo.countByRatingInRange(TENANT, start, end)).toEqual({
      1: 0, 2: 0, 3: 0, 4: 0, 5: 0,
    });
  });
});

describe('rating-count derive helpers', () => {
  it('totalResponses sums buckets', () => {
    expect(totalResponses({ 1: 1, 2: 0, 3: 2, 4: 0, 5: 3 })).toBe(6);
  });

  it('averageRating is null for zero responses and rounds to one decimal', () => {
    expect(averageRating({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })).toBeNull();
    expect(averageRating({ 1: 0, 2: 1, 3: 0, 4: 1, 5: 3 })).toBe(4.2); // 21/5
    expect(averageRating({ 1: 1, 2: 1, 3: 0, 4: 0, 5: 0 })).toBe(1.5); // 3/2
  });

  it('lowRatingCount sums 1-3 stars', () => {
    expect(lowRatingCount({ 1: 2, 2: 1, 3: 3, 4: 5, 5: 9 })).toBe(6);
  });
});
