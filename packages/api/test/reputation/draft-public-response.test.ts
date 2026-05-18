import { describe, it, expect, vi } from 'vitest';
import {
  draftPublicResponse,
  REVIEW_PUBLIC_RESPONSE_TASK_TYPE,
} from '../../src/reputation/draft-public-response';
import { NEUTRAL_BRAND_VOICE, type BrandVoice } from '../../src/reputation/brand-voice';
import type { Classification } from '../../src/reputation/classifier';
import type { Review } from '../../src/reputation/review';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: '22222222-2222-2222-2222-222222222222',
    externalReviewId: 'accounts/A/locations/L/reviews/R1',
    locationId: 'accounts/A/locations/L',
    reviewerDisplayName: 'Alice S.',
    reviewerProfileUrl: null,
    rating: 5,
    commentText: 'Great service!',
    createTime: new Date('2026-05-17T10:00:00Z'),
    updateTime: null,
    firstFetchedAt: new Date('2026-05-17T10:01:00Z'),
    lastFetchedAt: new Date('2026-05-17T10:01:00Z'),
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

describe('P7-026 draft-public-response', () => {
  it('uses the REVIEW_PUBLIC_RESPONSE_TASK_TYPE slug', async () => {
    const { gateway, calls } = makeMockGateway('Thank you for your kind words!');
    await draftPublicResponse(
      {
        review: makeReview(),
        classification: 'praise',
        brandVoice: NEUTRAL_BRAND_VOICE,
      },
      { llmGateway: gateway },
    );
    expect(calls[0].taskType).toBe(REVIEW_PUBLIC_RESPONSE_TASK_TYPE);
    expect(calls[0].taskType).toBe('review_public_response');
  });

  it('passes the review tenantId through to the gateway', async () => {
    const { gateway, calls } = makeMockGateway('Thanks!');
    const review = makeReview({ tenantId: '33333333-3333-3333-3333-333333333333' });
    await draftPublicResponse(
      { review, classification: 'praise', brandVoice: NEUTRAL_BRAND_VOICE },
      { llmGateway: gateway },
    );
    expect(calls[0].tenantId).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('redacts emails from the LLM output (defense in depth)', async () => {
    const { gateway } = makeMockGateway(
      'Thanks! Reach me at owner@example.com if you have questions.',
    );
    const out = await draftPublicResponse(
      {
        review: makeReview(),
        classification: 'praise',
        brandVoice: NEUTRAL_BRAND_VOICE,
      },
      { llmGateway: gateway },
    );
    expect(out).not.toContain('owner@example.com');
    expect(out).toContain('[email]');
  });

  it('redacts phone numbers from the LLM output', async () => {
    const { gateway } = makeMockGateway(
      'Sorry — call us at (555) 123-4567 to make this right.',
    );
    const out = await draftPublicResponse(
      {
        review: makeReview({ rating: 1 }),
        classification: 'specific_complaint',
        brandVoice: NEUTRAL_BRAND_VOICE,
      },
      { llmGateway: gateway },
    );
    expect(out).not.toContain('(555) 123-4567');
    expect(out).toContain('[phone]');
  });

  it('redacts review comment INPUT before sending to LLM (PII never reaches the model)', async () => {
    const { gateway, calls } = makeMockGateway('Thanks!');
    const review = makeReview({
      commentText: 'Wonderful! Reach me at customer@example.com',
    });
    await draftPublicResponse(
      { review, classification: 'praise', brandVoice: NEUTRAL_BRAND_VOICE },
      { llmGateway: gateway },
    );
    const userMessage = calls[0].messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage!.content).not.toContain('customer@example.com');
    expect(userMessage!.content).toContain('[email]');
  });

  it('includes brand voice tone in the system prompt when present', async () => {
    const { gateway, calls } = makeMockGateway('Thanks!');
    const brandVoice: BrandVoice = {
      tone: 'friendly, professional, concise',
      signoff: '— The Acme HVAC team',
    };
    await draftPublicResponse(
      { review: makeReview(), classification: 'praise', brandVoice },
      { llmGateway: gateway },
    );
    const systemMessage = calls[0].messages.find((m) => m.role === 'system');
    expect(systemMessage).toBeDefined();
    expect(systemMessage!.content).toContain('friendly, professional, concise');
    expect(systemMessage!.content).toContain('— The Acme HVAC team');
  });

  it('omits brand voice lines when tone and signoff are null', async () => {
    const { gateway, calls } = makeMockGateway('Thanks!');
    await draftPublicResponse(
      {
        review: makeReview(),
        classification: 'praise',
        brandVoice: NEUTRAL_BRAND_VOICE,
      },
      { llmGateway: gateway },
    );
    const systemMessage = calls[0].messages.find((m) => m.role === 'system');
    expect(systemMessage).toBeDefined();
    expect(systemMessage!.content).not.toContain('Tone guidance:');
    expect(systemMessage!.content).not.toContain('signoff');
  });

  it('includes the classification in the user prompt so the LLM picks the right tone', async () => {
    const { gateway, calls } = makeMockGateway('We apologize.');
    const classifications: Classification[] = [
      'praise',
      'specific_complaint',
      'vague_complaint',
    ];
    for (const classification of classifications) {
      calls.length = 0;
      await draftPublicResponse(
        {
          review: makeReview({ rating: 2 }),
          classification,
          brandVoice: NEUTRAL_BRAND_VOICE,
        },
        { llmGateway: gateway },
      );
      const userMessage = calls[0].messages.find((m) => m.role === 'user');
      expect(userMessage!.content).toContain(classification);
    }
  });
});
