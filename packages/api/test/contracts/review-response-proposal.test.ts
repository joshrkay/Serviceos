/**
 * P7-026 — Shared contract validation tests.
 *
 * The contract source lives in
 * `packages/shared/src/contracts/review-response-proposal.ts`. The
 * shared package does not have a vitest config wired (see
 * packages/shared/package.json), so the contract test runs from the
 * API package's vitest config — that's the existing pattern for
 * shared-imported types under packages/api/test/contracts/.
 */

import { describe, it, expect } from 'vitest';
import {
  reviewResponseProposalPayloadSchema,
  publicResponseSubPayloadSchema,
  privateMessageSubPayloadSchema,
  serviceCreditSubPayloadSchema,
  componentDecisionSchema,
  REVIEW_RESPONSE_PROPOSAL_TYPE,
  REVIEW_RESPONSE_CREDIT_CAP_CENTS,
} from '@ai-service-os/shared/dist/contracts/review-response-proposal.js';

const VALID_REVIEW_ID = '11111111-1111-1111-1111-111111111111';
const VALID_CUSTOMER_ID = '22222222-2222-2222-2222-222222222222';

describe('P7-026 review-response-proposal contract', () => {
  it('P7-026 exposes the discriminant constant', () => {
    expect(REVIEW_RESPONSE_PROPOSAL_TYPE).toBe('review_response');
  });

  it('P7-026 exposes the $100 hard cap (cents)', () => {
    expect(REVIEW_RESPONSE_CREDIT_CAP_CENTS).toBe(10000);
  });

  it('P7-026 component decision accepts the four expected values', () => {
    for (const v of ['pending', 'approved', 'edited', 'rejected']) {
      expect(componentDecisionSchema.parse(v)).toBe(v);
    }
    expect(() => componentDecisionSchema.parse('weird')).toThrow();
  });

  it('P7-026 validates a minimal payload (public-only)', () => {
    const minimal = {
      reviewId: VALID_REVIEW_ID,
      classification: 'praise',
      matchConfidence: 'none',
      publicResponse: { draft: 'Thanks for the kind words!' },
    };
    const parsed = reviewResponseProposalPayloadSchema.parse(minimal);
    expect(parsed.publicResponse?.decision).toBe('pending');
  });

  it('P7-026 validates a full payload (public + private + credit)', () => {
    const full = {
      reviewId: VALID_REVIEW_ID,
      classification: 'specific_complaint',
      matchConfidence: 'high',
      matchedCustomerId: VALID_CUSTOMER_ID,
      publicResponse: { draft: 'sorry', decision: 'approved' as const },
      privateMessage: {
        channel: 'sms' as const,
        draft: 'Hi, sorry',
        decision: 'approved' as const,
      },
      serviceCredit: {
        amountCents: 10000,
        remainingCapCents: 0,
        capApplied: false,
        decision: 'approved' as const,
      },
    };
    const parsed = reviewResponseProposalPayloadSchema.parse(full);
    expect(parsed.serviceCredit?.amountCents).toBe(10000);
  });

  it('P7-026 rejects credit amounts above the V1 cap', () => {
    expect(() =>
      serviceCreditSubPayloadSchema.parse({
        amountCents: 12500,
        remainingCapCents: 0,
        capApplied: false,
      }),
    ).toThrow();
  });

  it('P7-026 rejects fractional cent amounts (CLAUDE.md money rule)', () => {
    expect(() =>
      serviceCreditSubPayloadSchema.parse({
        amountCents: 1234.5,
        remainingCapCents: 0,
        capApplied: false,
      }),
    ).toThrow();
  });

  it('P7-026 rejects invalid UUID for reviewId', () => {
    expect(() =>
      reviewResponseProposalPayloadSchema.parse({
        reviewId: 'not-a-uuid',
        classification: 'praise',
        matchConfidence: 'none',
      }),
    ).toThrow();
  });

  it('P7-026 public response schema enforces non-empty draft', () => {
    expect(() => publicResponseSubPayloadSchema.parse({ draft: '' })).toThrow();
  });

  it('P7-026 private message schema enforces sms or email channel', () => {
    expect(() =>
      privateMessageSubPayloadSchema.parse({ channel: 'fax', draft: 'hi' }),
    ).toThrow();
    expect(privateMessageSubPayloadSchema.parse({ channel: 'sms', draft: 'hi' }).channel).toBe('sms');
    expect(privateMessageSubPayloadSchema.parse({ channel: 'email', draft: 'hi' }).channel).toBe('email');
  });
});
