import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  CustomerCandidate,
  CustomerLoader,
  MATCH_AMBIGUITY_MARGIN,
  MATCH_SCORE_THRESHOLD,
  matchReviewerToCustomer,
  scoreNameSimilarity,
} from '../../src/reputation/match-customer';
import { Review } from '../../src/reputation/review';

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: uuidv4(),
    tenantId: 't1',
    externalReviewId: 'accounts/a/locations/l/reviews/r1',
    locationId: 'accounts/a/locations/l',
    reviewerDisplayName: 'Alice Smith',
    reviewerProfileUrl: null,
    rating: 5,
    commentText: 'Great service',
    createTime: new Date('2026-05-10T10:00:00Z'),
    updateTime: new Date('2026-05-10T10:00:00Z'),
    firstFetchedAt: new Date('2026-05-10T10:01:00Z'),
    lastFetchedAt: new Date('2026-05-10T10:01:00Z'),
    ...overrides,
  };
}

class StubCustomerLoader implements CustomerLoader {
  constructor(private readonly candidates: CustomerCandidate[]) {}

  async findRecentCustomersWithName(
    _tenantId: string,
    _name: string,
    _sinceDays: number,
  ): Promise<CustomerCandidate[]> {
    return this.candidates;
  }
}

function makeCandidate(overrides: Partial<CustomerCandidate> = {}): CustomerCandidate {
  return {
    id: uuidv4(),
    firstName: 'Alice',
    lastName: 'Smith',
    lastVisitAt: new Date('2026-05-01T12:00:00Z'),
    ...overrides,
  };
}

describe('P7-026 scoreNameSimilarity', () => {
  it('returns 1.0 for exact match (case-insensitive)', () => {
    expect(scoreNameSimilarity('Alice Smith', 'alice smith')).toBe(1);
  });

  it('returns 0 for empty input', () => {
    expect(scoreNameSimilarity('', 'Alice Smith')).toBe(0);
    expect(scoreNameSimilarity('Alice', '')).toBe(0);
  });

  it('returns partial score for first-name-only match against full name', () => {
    // tokens "alice" vs "alice smith" → intersect 1, union 2 → 0.5
    expect(scoreNameSimilarity('Alice', 'Alice Smith')).toBe(0.5);
  });

  it('returns 0 for completely different names', () => {
    expect(scoreNameSimilarity('Alice Smith', 'Bob Jones')).toBe(0);
  });
});

describe('P7-026 matchReviewerToCustomer — empty/null reviewer name', () => {
  it('returns null when reviewerDisplayName is null', async () => {
    const loader = new StubCustomerLoader([makeCandidate()]);
    const result = await matchReviewerToCustomer(
      makeReview({ reviewerDisplayName: null }),
      { customerLoader: loader },
    );
    expect(result).toBeNull();
  });

  it('returns null when reviewerDisplayName is whitespace-only', async () => {
    const loader = new StubCustomerLoader([makeCandidate()]);
    const result = await matchReviewerToCustomer(
      makeReview({ reviewerDisplayName: '   ' }),
      { customerLoader: loader },
    );
    expect(result).toBeNull();
  });
});

describe('P7-026 matchReviewerToCustomer — no candidates', () => {
  it('returns null when loader returns empty list', async () => {
    const loader = new StubCustomerLoader([]);
    const result = await matchReviewerToCustomer(
      makeReview({ reviewerDisplayName: 'Alice Smith' }),
      { customerLoader: loader },
    );
    expect(result).toBeNull();
  });
});

describe('P7-026 matchReviewerToCustomer — single candidate', () => {
  it('returns the candidate when score exceeds threshold (exact match)', async () => {
    const candidate = makeCandidate({ firstName: 'Alice', lastName: 'Smith' });
    const loader = new StubCustomerLoader([candidate]);
    const result = await matchReviewerToCustomer(
      makeReview({ reviewerDisplayName: 'Alice Smith' }),
      { customerLoader: loader },
    );
    expect(result).not.toBeNull();
    expect(result?.customerId).toBe(candidate.id);
    expect(result?.matchScore).toBe(1);
    expect(result?.firstName).toBe('Alice');
    expect(result?.lastName).toBe('Smith');
  });

  it('returns null when single candidate score is below threshold', async () => {
    // "Alice" vs "Alice Smith" scores 0.5 — below 0.8 threshold.
    const candidate = makeCandidate({ firstName: 'Alice', lastName: 'Smith' });
    const loader = new StubCustomerLoader([candidate]);
    const result = await matchReviewerToCustomer(
      makeReview({ reviewerDisplayName: 'Alice' }),
      { customerLoader: loader },
    );
    expect(result).toBeNull();
  });
});

describe('P7-026 matchReviewerToCustomer — multiple candidates', () => {
  it('returns the top candidate when runner-up gap exceeds margin', async () => {
    const top = makeCandidate({ id: 'c1', firstName: 'Alice', lastName: 'Smith' });
    const farRunnerUp = makeCandidate({ id: 'c2', firstName: 'Alice', lastName: 'Jones' });
    const loader = new StubCustomerLoader([top, farRunnerUp]);
    const result = await matchReviewerToCustomer(
      makeReview({ reviewerDisplayName: 'Alice Smith' }),
      { customerLoader: loader },
    );
    // top score: 1.0, runner-up: 0.33. Gap 0.67 > margin 0.1 → top wins.
    expect(result?.customerId).toBe('c1');
    expect(result?.matchScore).toBe(1);
  });

  it('returns null on ambiguity (two candidates within margin)', async () => {
    // Both candidates score 1.0 — identical names, both above threshold.
    const a = makeCandidate({ id: 'c1', firstName: 'Alice', lastName: 'Smith' });
    const b = makeCandidate({ id: 'c2', firstName: 'Alice', lastName: 'Smith' });
    const loader = new StubCustomerLoader([a, b]);
    const result = await matchReviewerToCustomer(
      makeReview({ reviewerDisplayName: 'Alice Smith' }),
      { customerLoader: loader },
    );
    expect(result).toBeNull();
  });

  it('returns null when top score is below threshold even without ambiguity', async () => {
    // Reviewer "Alice" vs "Alice Brown" → 0.5; vs "Bob Jones" → 0. Top 0.5 < 0.8.
    const a = makeCandidate({ id: 'c1', firstName: 'Alice', lastName: 'Brown' });
    const b = makeCandidate({ id: 'c2', firstName: 'Bob', lastName: 'Jones' });
    const loader = new StubCustomerLoader([a, b]);
    const result = await matchReviewerToCustomer(
      makeReview({ reviewerDisplayName: 'Alice' }),
      { customerLoader: loader },
    );
    expect(result).toBeNull();
  });

  it('returns the top candidate when threshold met and runner-up is below threshold', async () => {
    // Full-match (1.0) vs partial-match (0.33). Margin 0.67 > 0.1 → match.
    const top = makeCandidate({
      id: 'c1',
      firstName: 'Alice',
      lastName: 'Smith',
      lastVisitAt: new Date('2026-05-10T10:00:00Z'),
    });
    const weak = makeCandidate({ id: 'c2', firstName: 'Bob', lastName: 'Smith' });
    const loader = new StubCustomerLoader([weak, top]); // unsorted on input
    const result = await matchReviewerToCustomer(
      makeReview({ reviewerDisplayName: 'Alice Smith' }),
      { customerLoader: loader },
    );
    expect(result?.customerId).toBe('c1');
    expect(result?.lastVisitAt.getTime()).toBe(
      new Date('2026-05-10T10:00:00Z').getTime(),
    );
  });
});

describe('P7-026 match constants', () => {
  it('threshold and margin are exported as documented', () => {
    expect(MATCH_SCORE_THRESHOLD).toBe(0.8);
    expect(MATCH_AMBIGUITY_MARGIN).toBe(0.1);
  });
});
