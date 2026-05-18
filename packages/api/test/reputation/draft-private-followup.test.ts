import { describe, it, expect, vi } from 'vitest';
import {
  draftPrivateFollowUp,
  REVIEW_PRIVATE_FOLLOWUP_TASK_TYPE,
} from '../../src/reputation/draft-private-followup';
import { NEUTRAL_BRAND_VOICE, type BrandVoice } from '../../src/reputation/brand-voice';
import type { MatchedCustomer } from '../../src/reputation/match-customer';
import type { Review } from '../../src/reputation/review';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: '22222222-2222-2222-2222-222222222222',
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

function makeMatched(overrides: Partial<MatchedCustomer> = {}): MatchedCustomer {
  return {
    customerId: '44444444-4444-4444-4444-444444444444',
    firstName: 'Alice',
    lastName: 'Smith',
    lastVisitAt: new Date('2026-05-10T10:00:00Z'),
    matchScore: 1.0,
    ...overrides,
  };
}

function makeMockGateway(response: string): {
  gateway: LLMGateway;
  calls: LLMRequest[];
} {
  const calls: LLMRequest[] = [];
  const gateway = {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
      calls.push(req);
      return {
        content: response,
        model: 'test',
        provider: 'mock',
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: 0,
      };
    }),
  } as unknown as LLMGateway;
  return { gateway, calls };
}

describe('P7-026 draft-private-followup', () => {
  it('uses the REVIEW_PRIVATE_FOLLOWUP_TASK_TYPE slug', async () => {
    const { gateway, calls } = makeMockGateway('Hi Alice, we apologize.');
    await draftPrivateFollowUp(
      {
        review: makeReview(),
        classification: 'specific_complaint',
        brandVoice: NEUTRAL_BRAND_VOICE,
        matchedCustomer: makeMatched(),
        channel: 'email',
      },
      { llmGateway: gateway },
    );
    expect(calls[0].taskType).toBe(REVIEW_PRIVATE_FOLLOWUP_TASK_TYPE);
    expect(calls[0].taskType).toBe('review_private_followup');
  });

  it('preserves matched customer first name in output (Hi Alice stays readable)', async () => {
    const { gateway } = makeMockGateway('Hi Alice, we sincerely apologize for the missed visit.');
    const out = await draftPrivateFollowUp(
      {
        review: makeReview(),
        classification: 'specific_complaint',
        brandVoice: NEUTRAL_BRAND_VOICE,
        matchedCustomer: makeMatched(),
        channel: 'email',
      },
      { llmGateway: gateway },
    );
    expect(out).toContain('Alice');
  });

  it('still redacts other PII (emails, phones, other names)', async () => {
    const { gateway } = makeMockGateway(
      'Hi Alice, reach our manager Bob Jones at manager@example.com or (555) 123-4567.',
    );
    const out = await draftPrivateFollowUp(
      {
        review: makeReview(),
        classification: 'specific_complaint',
        brandVoice: NEUTRAL_BRAND_VOICE,
        matchedCustomer: makeMatched(),
        channel: 'email',
      },
      { llmGateway: gateway },
    );
    expect(out).not.toContain('manager@example.com');
    expect(out).not.toContain('(555) 123-4567');
    expect(out).toContain('[email]');
    expect(out).toContain('[phone]');
    // Bob (common first name) → "Bob [name]" — Jones gets stripped.
    expect(out).not.toContain('Bob Jones');
  });

  it('includes customer first name in the user prompt', async () => {
    const { gateway, calls } = makeMockGateway('Hi Alice.');
    await draftPrivateFollowUp(
      {
        review: makeReview(),
        classification: 'specific_complaint',
        brandVoice: NEUTRAL_BRAND_VOICE,
        matchedCustomer: makeMatched({ firstName: 'Alice' }),
        channel: 'email',
      },
      { llmGateway: gateway },
    );
    const userMessage = calls[0].messages.find((m) => m.role === 'user');
    expect(userMessage!.content).toContain('Alice');
  });

  it('SMS channel produces a system prompt with SMS length guidance', async () => {
    const { gateway, calls } = makeMockGateway('Hi Alice.');
    await draftPrivateFollowUp(
      {
        review: makeReview(),
        classification: 'specific_complaint',
        brandVoice: NEUTRAL_BRAND_VOICE,
        matchedCustomer: makeMatched(),
        channel: 'sms',
      },
      { llmGateway: gateway },
    );
    const systemMessage = calls[0].messages.find((m) => m.role === 'system');
    expect(systemMessage!.content.toLowerCase()).toContain('sms');
  });

  it('email channel produces a system prompt with email guidance', async () => {
    const { gateway, calls } = makeMockGateway('Hi Alice.');
    await draftPrivateFollowUp(
      {
        review: makeReview(),
        classification: 'praise',
        brandVoice: NEUTRAL_BRAND_VOICE,
        matchedCustomer: makeMatched(),
        channel: 'email',
      },
      { llmGateway: gateway },
    );
    const systemMessage = calls[0].messages.find((m) => m.role === 'system');
    expect(systemMessage!.content.toLowerCase()).toContain('email');
  });

  it('includes brand voice tone + signoff in the system prompt when present', async () => {
    const { gateway, calls } = makeMockGateway('Hi Alice.');
    const brandVoice: BrandVoice = {
      tone: 'warm and apologetic',
      signoff: 'Sincerely, Acme HVAC',
    };
    await draftPrivateFollowUp(
      {
        review: makeReview(),
        classification: 'specific_complaint',
        brandVoice,
        matchedCustomer: makeMatched(),
        channel: 'email',
      },
      { llmGateway: gateway },
    );
    const systemMessage = calls[0].messages.find((m) => m.role === 'system');
    expect(systemMessage!.content).toContain('warm and apologetic');
    expect(systemMessage!.content).toContain('Sincerely, Acme HVAC');
  });

  it('passes tenantId through to gateway', async () => {
    const { gateway, calls } = makeMockGateway('Hi.');
    await draftPrivateFollowUp(
      {
        review: makeReview({ tenantId: '55555555-5555-5555-5555-555555555555' }),
        classification: 'praise',
        brandVoice: NEUTRAL_BRAND_VOICE,
        matchedCustomer: makeMatched(),
        channel: 'email',
      },
      { llmGateway: gateway },
    );
    expect(calls[0].tenantId).toBe('55555555-5555-5555-5555-555555555555');
  });
});
