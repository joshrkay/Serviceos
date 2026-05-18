import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryReviewRepository, Review } from '../../src/reputation/review';

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: uuidv4(),
    tenantId: 't1',
    externalReviewId: 'accounts/a/locations/l/reviews/r1',
    locationId: 'accounts/a/locations/l',
    reviewerDisplayName: 'Alice',
    reviewerProfileUrl: null,
    rating: 5,
    commentText: 'Great service',
    createTime: new Date('2026-05-10T10:00:00Z'),
    updateTime: new Date('2026-05-10T10:00:00Z'),
    fetchedAt: new Date('2026-05-10T10:01:00Z'),
    ...overrides,
  };
}

describe('P7-026 InMemoryReviewRepository', () => {
  it('reports inserted=true on first insert and persists the row', async () => {
    const repo = new InMemoryReviewRepository();
    const review = makeReview();

    const result = await repo.upsert(review);

    expect(result.inserted).toBe(true);
    expect(result.review.id).toBe(review.id);
    expect(repo.size()).toBe(1);
  });

  it('reports inserted=false on a re-upsert and updates mutable fields', async () => {
    const repo = new InMemoryReviewRepository();
    const original = makeReview({ rating: 3, commentText: 'meh' });
    await repo.upsert(original);

    const updated = await repo.upsert({
      ...original,
      // The worker generates a new id each call — repo MUST keep the
      // original id so downstream rows (PR c proposals) don't break.
      id: uuidv4(),
      rating: 5,
      commentText: 'great after followup',
      updateTime: new Date('2026-05-11T10:00:00Z'),
    });

    expect(updated.inserted).toBe(false);
    expect(updated.review.id).toBe(original.id);
    expect(updated.review.rating).toBe(5);
    expect(updated.review.commentText).toBe('great after followup');
    expect(repo.size()).toBe(1);
  });

  it('isolates rows by tenant', async () => {
    const repo = new InMemoryReviewRepository();
    await repo.upsert(makeReview({ tenantId: 't1' }));
    await repo.upsert(makeReview({ tenantId: 't2' }));

    expect(repo.size()).toBe(2);
    expect(await repo.findByExternalId('t1', 'accounts/a/locations/l/reviews/r1'))
      .not.toBeNull();
    expect(await repo.findByExternalId('t3', 'accounts/a/locations/l/reviews/r1'))
      .toBeNull();
  });
});
