/**
 * P7-026 — Proposal-builder tests.
 *
 * Covers:
 *   - wrong_business short-circuits (no proposal drafted)
 *   - praise reviews draft a public response but no private/credit
 *   - high-confidence match → public + private + capped credit
 *   - low-confidence match → public only (no private, no credit)
 *   - the public draft never leaks PII (poison-prompt LLM still gets
 *     redacted)
 *   - the 12-month cap clamps the credit suggestion before the proposal
 *     is built
 *
 * The handler-side tests live in
 * `packages/api/test/proposals/execution/review-response-handler.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildReviewResponseProposal } from '../../src/reputation/build-proposal';
import { InMemoryServiceCreditRepository } from '../../src/reputation/service-credit-repository';
import type { GoogleReview, ReviewClassification } from '../../src/reputation/types';
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';

const TENANT = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-05-17T18:00:00Z');

function gateway(
  respond: (req: LLMRequest) => string,
): { complete: (req: LLMRequest) => Promise<LLMResponse> } {
  return {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      return {
        content: respond(req),
        model: 'test',
        provider: 'test',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 0,
      };
    },
  };
}

function makeReview(overrides?: Partial<GoogleReview>): GoogleReview {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    connectionId: 'conn-1',
    googleReviewId: 'gr-1',
    reviewerName: 'Margaret Donovan',
    rating: 1,
    commentText: 'Carlos never showed up for the 5pm appointment.',
    postedAt: NOW,
    classification: 'specific_complaint' as ReviewClassification,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const brand = { businessName: 'Fieldly HVAC', ownerDisplayName: 'Mike' };

describe('P7-026 buildReviewResponseProposal', () => {
  it('P7-026 short-circuits on wrong_business classification (no proposal)', async () => {
    const review = makeReview({ classification: 'wrong_business' });
    const result = await buildReviewResponseProposal({
      review,
      brand,
      gateway: gateway(() => 'irrelevant') as never,
      creditRepo: new InMemoryServiceCreditRepository(),
      createdBy: 'system',
      now: NOW,
    });
    expect(result.proposal).toBeNull();
    expect(result.reason).toMatch(/wrong_business/);
  });

  it('P7-026 returns null when classification is missing', async () => {
    const review = makeReview({ classification: undefined });
    const result = await buildReviewResponseProposal({
      review,
      brand,
      gateway: gateway(() => 'ignored') as never,
      creditRepo: new InMemoryServiceCreditRepository(),
      createdBy: 'system',
      now: NOW,
    });
    expect(result.proposal).toBeNull();
  });

  it('P7-026 praise reviews draft a public response but no private/credit', async () => {
    const review = makeReview({
      classification: 'praise',
      rating: 5,
      commentText: 'Excellent work!',
    });
    const result = await buildReviewResponseProposal({
      review,
      brand,
      gateway: gateway(() => 'Thank you so much for the kind words!') as never,
      creditRepo: new InMemoryServiceCreditRepository(),
      createdBy: 'system',
      now: NOW,
    });
    expect(result.proposal).not.toBeNull();
    const payload = result.proposal!.payload as Record<string, unknown>;
    expect(payload.publicResponse).toBeDefined();
    expect(payload.privateMessage).toBeUndefined();
    expect(payload.serviceCredit).toBeUndefined();
  });

  it('P7-026 high-confidence match → public + private + capped credit', async () => {
    const review = makeReview({ rating: 1, classification: 'specific_complaint' });
    const result = await buildReviewResponseProposal({
      review,
      brand,
      matched: {
        confidence: 'high',
        customer: {
          customerId: 'cust-donovan',
          firstName: 'Margaret',
          lastName: 'Donovan',
        },
      },
      gateway: gateway((req) => {
        // Public + private both pass through the gateway. Return clean
        // text (no PII) so the redactor is satisfied.
        if (req.taskType === 'review_public_response') {
          return "We're really sorry to hear this and we'd like to make it right.";
        }
        return 'Hi Margaret, this is Mike at Fieldly HVAC. We want to make this right.';
      }) as never,
      creditRepo: new InMemoryServiceCreditRepository(),
      createdBy: 'system',
      now: NOW,
    });
    expect(result.proposal).not.toBeNull();
    const payload = result.proposal!.payload as {
      publicResponse: { draft: string };
      privateMessage: { channel: 'sms' | 'email'; draft: string };
      serviceCredit: { amountCents: number; capApplied: boolean };
      matchedCustomerId: string;
    };
    expect(payload.publicResponse.draft).toMatch(/sorry/i);
    expect(payload.privateMessage.draft).toMatch(/Margaret/);
    expect(payload.serviceCredit.amountCents).toBe(10000); // $100 for 1-star specific
    expect(payload.serviceCredit.capApplied).toBe(false);
    expect(payload.matchedCustomerId).toBe('cust-donovan');
  });

  it('P7-026 low-confidence match → public only (no private, no credit)', async () => {
    const review = makeReview({ rating: 1, classification: 'specific_complaint' });
    const result = await buildReviewResponseProposal({
      review,
      brand,
      matched: {
        confidence: 'low',
        customer: {
          customerId: 'cust-uncertain',
          firstName: 'Margaret',
          lastName: 'Donovan',
        },
      },
      gateway: gateway(() => 'We are very sorry, please reach out so we can help.') as never,
      creditRepo: new InMemoryServiceCreditRepository(),
      createdBy: 'system',
      now: NOW,
    });
    const payload = result.proposal!.payload as Record<string, unknown>;
    expect(payload.publicResponse).toBeDefined();
    expect(payload.privateMessage).toBeUndefined();
    expect(payload.serviceCredit).toBeUndefined();
    // The unverified customer ID still surfaces so the UI can flag it.
    expect(payload.matchedCustomerId).toBe('cust-uncertain');
    expect(payload.matchConfidence).toBe('low');
  });

  it('P7-026 POISON PROMPT: LLM is "tricked" into PII — redactor still strips it before proposal', async () => {
    const review = makeReview({ rating: 1 });
    const poisoned = `Dear Margaret Donovan, we are so sorry. Please call us at
      (415) 555-1234 or visit our office at 1234 Oak Street. Email us at
      mike@fieldlyhvac.example.com — reference JOB-001-ABCD.`;
    const result = await buildReviewResponseProposal({
      review,
      brand,
      matched: {
        confidence: 'high',
        customer: {
          customerId: 'cust-donovan',
          firstName: 'Margaret',
          lastName: 'Donovan',
        },
      },
      gateway: gateway((req) =>
        req.taskType === 'review_public_response' ? poisoned : 'Hi Margaret, sorry about that — Mike',
      ) as never,
      creditRepo: new InMemoryServiceCreditRepository(),
      createdBy: 'system',
      now: NOW,
    });
    const payload = result.proposal!.payload as {
      publicResponse: { draft: string };
    };
    const draft = payload.publicResponse.draft;
    // None of the PII may survive into the proposal payload.
    expect(draft).not.toMatch(/415.*555.*1234/);
    expect(draft).not.toContain('1234 Oak Street');
    expect(draft).not.toContain('mike@fieldlyhvac.example.com');
    expect(draft).not.toContain('Donovan');
    expect(draft).not.toContain('JOB-001-ABCD');
  });

  it('P7-026 12-month cap clamps the credit suggestion at the proposal-build boundary', async () => {
    const review = makeReview({ rating: 1, classification: 'specific_complaint' });
    const creditRepo = new InMemoryServiceCreditRepository();
    // Customer already received $75 in the trailing 12 months.
    await creditRepo.create({
      id: 'c1',
      tenantId: TENANT,
      customerId: 'cust-donovan',
      amountCents: 7500,
      issuedAt: new Date('2026-02-15T00:00:00Z'),
      issuedByUserId: 'u1',
      createdAt: new Date('2026-02-15T00:00:00Z'),
    });
    const result = await buildReviewResponseProposal({
      review,
      brand,
      matched: {
        confidence: 'high',
        customer: {
          customerId: 'cust-donovan',
          firstName: 'Margaret',
          lastName: 'Donovan',
        },
      },
      gateway: gateway(() => 'Sorry — Mike') as never,
      creditRepo,
      createdBy: 'system',
      now: NOW,
    });
    const payload = result.proposal!.payload as {
      serviceCredit: { amountCents: number; capApplied: boolean; remainingCapCents: number };
    };
    // $100 suggestion clamped to remaining $25.
    expect(payload.serviceCredit.amountCents).toBe(2500);
    expect(payload.serviceCredit.capApplied).toBe(true);
    expect(payload.serviceCredit.remainingCapCents).toBe(0);
  });

  it('P7-026 proposal is created in draft status (review_response never auto-approves)', async () => {
    const review = makeReview({ classification: 'specific_complaint', rating: 1 });
    const result = await buildReviewResponseProposal({
      review,
      brand,
      gateway: gateway(() => 'sorry') as never,
      creditRepo: new InMemoryServiceCreditRepository(),
      createdBy: 'system',
      now: NOW,
    });
    expect(result.proposal!.status).toBe('draft');
  });
});
