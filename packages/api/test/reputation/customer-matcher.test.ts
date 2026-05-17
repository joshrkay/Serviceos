/**
 * P7-026 — Customer-matcher tests.
 *
 * Verifies the conservative-match contract: high-confidence requires
 * BOTH name similarity AND a recent visit; otherwise the matcher flags
 * 'low' (so the proposal builder omits the private draft) or 'none'.
 */

import { describe, it, expect } from 'vitest';
import {
  matchReviewerToCustomer,
  type CandidateCustomer,
  type RecentVisit,
} from '../../src/reputation/customer-matcher';

const donovan: CandidateCustomer = {
  id: 'cust-donovan',
  displayName: 'Margaret Donovan',
  firstName: 'Margaret',
  lastName: 'Donovan',
};

const smith: CandidateCustomer = {
  id: 'cust-smith',
  displayName: 'John Smith',
  firstName: 'John',
  lastName: 'Smith',
};

describe('P7-026 customer matcher', () => {
  const REVIEW_AT = new Date('2026-05-17T18:00:00Z');

  it('P7-026 high confidence: name match + visit within 7 days', () => {
    const result = matchReviewerToCustomer({
      reviewerName: 'Margaret Donovan',
      reviewPostedAt: REVIEW_AT,
      candidates: [donovan, smith],
      recentVisits: [
        { customerId: donovan.id, visitAt: new Date('2026-05-15T17:00:00Z') },
      ],
    });
    expect(result.confidence).toBe('high');
    expect(result.customerId).toBe(donovan.id);
  });

  it('P7-026 low confidence: name matches but no visit in window', () => {
    const result = matchReviewerToCustomer({
      reviewerName: 'Margaret Donovan',
      reviewPostedAt: REVIEW_AT,
      candidates: [donovan, smith],
      recentVisits: [], // no recent visit
    });
    expect(result.confidence).toBe('low');
    expect(result.customerId).toBe(donovan.id);
  });

  it('P7-026 low confidence: visit too far outside window', () => {
    const result = matchReviewerToCustomer({
      reviewerName: 'Margaret Donovan',
      reviewPostedAt: REVIEW_AT,
      candidates: [donovan],
      recentVisits: [
        // 30 days before
        { customerId: donovan.id, visitAt: new Date('2026-04-17T17:00:00Z') },
      ],
    });
    expect(result.confidence).toBe('low');
  });

  it('P7-026 no match for a short common name even with same-named candidate', () => {
    const result = matchReviewerToCustomer({
      reviewerName: 'Jo',
      reviewPostedAt: REVIEW_AT,
      candidates: [
        { id: 'cust-jo', displayName: 'Jo', firstName: 'Jo', lastName: '' },
      ],
      recentVisits: [
        { customerId: 'cust-jo', visitAt: REVIEW_AT },
      ],
    });
    expect(result.confidence).toBe('none');
  });

  it('P7-026 typo tolerance: small name variation still high-confidence with visit', () => {
    const result = matchReviewerToCustomer({
      reviewerName: 'Margret Donovan', // dropped letter
      reviewPostedAt: REVIEW_AT,
      candidates: [donovan],
      recentVisits: [
        { customerId: donovan.id, visitAt: new Date('2026-05-15T17:00:00Z') },
      ],
    });
    expect(result.confidence).toBe('high');
  });

  it('P7-026 returns none when there is no name overlap', () => {
    const result = matchReviewerToCustomer({
      reviewerName: 'Someone Else Entirely',
      reviewPostedAt: REVIEW_AT,
      candidates: [donovan, smith],
      recentVisits: [
        { customerId: donovan.id, visitAt: REVIEW_AT },
      ],
    });
    expect(result.confidence).toBe('none');
  });

  it('P7-026 returns none for an empty reviewer name', () => {
    const result = matchReviewerToCustomer({
      reviewerName: '   ',
      reviewPostedAt: REVIEW_AT,
      candidates: [donovan],
      recentVisits: [],
    });
    expect(result.confidence).toBe('none');
  });
});
