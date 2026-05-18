import { describe, it, expect, vi } from 'vitest';
import { buildReviewResponseProposal } from '../../src/reputation/build-proposal';
import { NoopBrandVoiceLoader } from '../../src/reputation/brand-voice';
import { InMemoryServiceCreditRepository } from '../../src/reputation/service-credit';
import type { Review } from '../../src/reputation/review';
import type { MatchedCustomer } from '../../src/reputation/match-customer';
import type { ClassificationResult } from '../../src/reputation/classifier';
import type { LLMGateway } from '../../src/ai/gateway/gateway';

const TENANT = '22222222-2222-2222-2222-222222222222';
const CUSTOMER = '44444444-4444-4444-4444-444444444444';

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: TENANT,
    externalReviewId: 'accounts/A/locations/L/reviews/R1',
    locationId: 'accounts/A/locations/L',
    reviewerDisplayName: 'Alice Smith',
    reviewerProfileUrl: null,
    rating: 1,
    commentText: 'Terrible — the tech never showed.',
    createTime: new Date('2026-05-17T10:00:00Z'),
    updateTime: null,
    firstFetchedAt: new Date('2026-05-17T10:01:00Z'),
    lastFetchedAt: new Date('2026-05-17T10:01:00Z'),
    ...overrides,
  };
}

function makeMatched(): MatchedCustomer {
  return {
    customerId: CUSTOMER,
    firstName: 'Alice',
    lastName: 'Smith',
    lastVisitAt: new Date('2026-05-10T10:00:00Z'),
    matchScore: 1.0,
  };
}

function fakeClassifier(result: ClassificationResult) {
  return vi.fn(async () => result);
}

function fakeDraftPublic(text: string) {
  return vi.fn(async () => text);
}

function fakeDraftPrivate(body: string) {
  return vi.fn(async () => body);
}

// Stubs for fields the orchestrator does not exercise when classifier
// + matcher + drafts are all injected (LLMGateway, CustomerLoader).
const stubGateway = {} as unknown as LLMGateway;
const stubCustomerLoader = {
  findRecentCustomersWithName: vi.fn(),
};

describe('P7-026 buildReviewResponseProposal', () => {
  describe('public response is ALWAYS drafted', () => {
    it('praise + no match → public only', async () => {
      const result = await buildReviewResponseProposal(
        makeReview({ rating: 5, commentText: 'Great service!' }),
        {
          llmGateway: stubGateway,
          customerLoader: stubCustomerLoader,
          brandVoiceLoader: new NoopBrandVoiceLoader(),
          serviceCreditRepo: new InMemoryServiceCreditRepository(),
          classifier: fakeClassifier({
            classification: 'praise',
            confidence: 0.95,
            source: 'regex',
          }),
          matcher: vi.fn(async () => null),
          draftPublic: fakeDraftPublic('Thanks for the kind words!'),
          draftPrivate: fakeDraftPrivate('UNUSED'),
        },
      );

      expect(result.publicResponse.text).toBe('Thanks for the kind words!');
      expect(result.publicResponse.approved).toBe(false);
      expect(result.privateFollowUp).toBeNull();
      expect(result.serviceCredit).toBeNull();
      expect(result.classification).toBe('praise');
      expect(result.reviewId).toBe('11111111-1111-1111-1111-111111111111');
    });
  });

  describe('match + complaint → 3 components, cap allows', () => {
    it('specific 1★ + match + zero prior credit → all 3 components, credit $100', async () => {
      const repo = new InMemoryServiceCreditRepository();
      const result = await buildReviewResponseProposal(makeReview({ rating: 1 }), {
        llmGateway: stubGateway,
        customerLoader: stubCustomerLoader,
        brandVoiceLoader: new NoopBrandVoiceLoader(),
        serviceCreditRepo: repo,
        classifier: fakeClassifier({
          classification: 'specific_complaint',
          confidence: 0.95,
          source: 'regex',
        }),
        matcher: vi.fn(async () => makeMatched()),
        draftPublic: fakeDraftPublic('We apologize.'),
        draftPrivate: fakeDraftPrivate('Hi Alice, we apologize.'),
      });

      expect(result.publicResponse.text).toBe('We apologize.');
      expect(result.publicResponse.approved).toBe(false);
      expect(result.privateFollowUp).not.toBeNull();
      expect(result.privateFollowUp!.customerId).toBe(CUSTOMER);
      expect(result.privateFollowUp!.body).toBe('Hi Alice, we apologize.');
      expect(result.privateFollowUp!.channel).toBe('email');
      expect(result.privateFollowUp!.approved).toBe(false);
      expect(result.serviceCredit).not.toBeNull();
      expect(result.serviceCredit!.amountCents).toBe(10000);
      expect(result.serviceCredit!.approved).toBe(false);
      expect(result.serviceCredit!.customerId).toBe(CUSTOMER);
    });

    it('vague 1★ + match → public + private + $50 credit', async () => {
      const result = await buildReviewResponseProposal(
        makeReview({ rating: 1, commentText: 'Bad.' }),
        {
          llmGateway: stubGateway,
          customerLoader: stubCustomerLoader,
          brandVoiceLoader: new NoopBrandVoiceLoader(),
          serviceCreditRepo: new InMemoryServiceCreditRepository(),
          classifier: fakeClassifier({
            classification: 'vague_complaint',
            confidence: 0.9,
            source: 'llm',
          }),
          matcher: vi.fn(async () => makeMatched()),
          draftPublic: fakeDraftPublic('Sorry to hear that.'),
          draftPrivate: fakeDraftPrivate('Hi Alice, sorry.'),
        },
      );
      expect(result.serviceCredit).not.toBeNull();
      expect(result.serviceCredit!.amountCents).toBe(5000);
    });
  });

  describe('cap enforcement at DRAFT time', () => {
    it('specific 1★ + match + $90 prior credit → public + private + NO credit (cap exhausted)', async () => {
      const repo = new InMemoryServiceCreditRepository();
      // Seed $90 of prior credit so a new $100 (specific 1★) would
      // push us over the $100 cap.
      await repo.create({
        tenantId: TENANT,
        customerId: CUSTOMER,
        amountCents: 9000,
        reviewId: null,
        proposalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      });

      const result = await buildReviewResponseProposal(makeReview({ rating: 1 }), {
        llmGateway: stubGateway,
        customerLoader: stubCustomerLoader,
        brandVoiceLoader: new NoopBrandVoiceLoader(),
        serviceCreditRepo: repo,
        classifier: fakeClassifier({
          classification: 'specific_complaint',
          confidence: 0.95,
          source: 'regex',
        }),
        matcher: vi.fn(async () => makeMatched()),
        draftPublic: fakeDraftPublic('We apologize.'),
        draftPrivate: fakeDraftPrivate('Hi Alice.'),
      });

      expect(result.publicResponse.text).toBe('We apologize.');
      expect(result.privateFollowUp).not.toBeNull();
      // CRITICAL: cap exhausted → no credit suggestion at all.
      expect(result.serviceCredit).toBeNull();
    });

    it('exactly at cap boundary is allowed ($100 prior would block, but $90 prior + $25 = $115 over cap)', async () => {
      const repo = new InMemoryServiceCreditRepository();
      // $75 prior + $25 (specific 3★) = exactly $100 cap. Allowed.
      await repo.create({
        tenantId: TENANT,
        customerId: CUSTOMER,
        amountCents: 7500,
        reviewId: null,
        proposalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      });
      const result = await buildReviewResponseProposal(makeReview({ rating: 3 }), {
        llmGateway: stubGateway,
        customerLoader: stubCustomerLoader,
        brandVoiceLoader: new NoopBrandVoiceLoader(),
        serviceCreditRepo: repo,
        classifier: fakeClassifier({
          classification: 'specific_complaint',
          confidence: 0.95,
          source: 'regex',
        }),
        matcher: vi.fn(async () => makeMatched()),
        draftPublic: fakeDraftPublic('public'),
        draftPrivate: fakeDraftPrivate('private'),
      });
      expect(result.serviceCredit).not.toBeNull();
      expect(result.serviceCredit!.amountCents).toBe(2500);
    });
  });

  describe('no matched customer → public only', () => {
    it('1★ complaint with NO match → public only (no private, no credit)', async () => {
      const result = await buildReviewResponseProposal(makeReview({ rating: 1 }), {
        llmGateway: stubGateway,
        customerLoader: stubCustomerLoader,
        brandVoiceLoader: new NoopBrandVoiceLoader(),
        serviceCreditRepo: new InMemoryServiceCreditRepository(),
        classifier: fakeClassifier({
          classification: 'specific_complaint',
          confidence: 0.95,
          source: 'regex',
        }),
        matcher: vi.fn(async () => null),
        draftPublic: fakeDraftPublic('We apologize.'),
        draftPrivate: fakeDraftPrivate('UNUSED'),
      });
      expect(result.publicResponse.text).toBe('We apologize.');
      expect(result.privateFollowUp).toBeNull();
      expect(result.serviceCredit).toBeNull();
    });

    it('does NOT call draftPrivate when no match', async () => {
      const draftPrivate = fakeDraftPrivate('UNUSED');
      await buildReviewResponseProposal(makeReview({ rating: 1 }), {
        llmGateway: stubGateway,
        customerLoader: stubCustomerLoader,
        brandVoiceLoader: new NoopBrandVoiceLoader(),
        serviceCreditRepo: new InMemoryServiceCreditRepository(),
        classifier: fakeClassifier({
          classification: 'specific_complaint',
          confidence: 0.95,
          source: 'regex',
        }),
        matcher: vi.fn(async () => null),
        draftPublic: fakeDraftPublic('public'),
        draftPrivate,
      });
      expect(draftPrivate).not.toHaveBeenCalled();
    });
  });

  describe('default approved flags', () => {
    it('all approved flags default to false (owner must explicitly approve)', async () => {
      const result = await buildReviewResponseProposal(makeReview({ rating: 1 }), {
        llmGateway: stubGateway,
        customerLoader: stubCustomerLoader,
        brandVoiceLoader: new NoopBrandVoiceLoader(),
        serviceCreditRepo: new InMemoryServiceCreditRepository(),
        classifier: fakeClassifier({
          classification: 'specific_complaint',
          confidence: 0.95,
          source: 'regex',
        }),
        matcher: vi.fn(async () => makeMatched()),
        draftPublic: fakeDraftPublic('public'),
        draftPrivate: fakeDraftPrivate('private'),
      });
      expect(result.publicResponse.approved).toBe(false);
      expect(result.privateFollowUp?.approved).toBe(false);
      expect(result.serviceCredit?.approved).toBe(false);
    });
  });

  describe('praise + matched customer → public + private, no credit', () => {
    it('5★ praise + match → public + private, credit is null (praise tier is $0)', async () => {
      const repo = new InMemoryServiceCreditRepository();
      const result = await buildReviewResponseProposal(makeReview({ rating: 5 }), {
        llmGateway: stubGateway,
        customerLoader: stubCustomerLoader,
        brandVoiceLoader: new NoopBrandVoiceLoader(),
        serviceCreditRepo: repo,
        classifier: fakeClassifier({
          classification: 'praise',
          confidence: 0.95,
          source: 'regex',
        }),
        matcher: vi.fn(async () => makeMatched()),
        draftPublic: fakeDraftPublic('Thanks!'),
        draftPrivate: fakeDraftPrivate('Hi Alice, thanks!'),
      });
      expect(result.publicResponse).toBeDefined();
      expect(result.privateFollowUp).not.toBeNull();
      expect(result.serviceCredit).toBeNull();
    });
  });

  describe('payload shape passes shared Zod schema', () => {
    it('produced payload is valid against reviewResponseProposalPayloadSchema', async () => {
      const { reviewResponseProposalPayloadSchema } = await import('@ai-service-os/shared');
      const payload = await buildReviewResponseProposal(makeReview({ rating: 1 }), {
        llmGateway: stubGateway,
        customerLoader: stubCustomerLoader,
        brandVoiceLoader: new NoopBrandVoiceLoader(),
        serviceCreditRepo: new InMemoryServiceCreditRepository(),
        classifier: fakeClassifier({
          classification: 'specific_complaint',
          confidence: 0.95,
          source: 'regex',
        }),
        matcher: vi.fn(async () => makeMatched()),
        draftPublic: fakeDraftPublic('We apologize sincerely.'),
        draftPrivate: fakeDraftPrivate('Hi Alice, we apologize sincerely.'),
      });
      const result = reviewResponseProposalPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });
});
