import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  classifyReview,
  LLM_CONFIDENCE_FLOOR,
  REVIEW_CLASSIFY_TASK_TYPE,
} from '../../src/reputation/classifier';
import { Review } from '../../src/reputation/review';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';

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
    firstFetchedAt: new Date('2026-05-10T10:01:00Z'),
    lastFetchedAt: new Date('2026-05-10T10:01:00Z'),
    ...overrides,
  };
}

describe('P7-026 classifyReview — regex praise', () => {
  it('classifies praise from keyword match (regex, no LLM call)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    const result = await classifyReview(
      makeReview({ rating: 5, commentText: 'Amazing work, thank you!' }),
      { llmGateway: gateway },
    );

    expect(result.classification).toBe('praise');
    expect(result.source).toBe('regex');
    expect(result.confidence).toBe(1.0);
    expect(provider.getCalls()).toHaveLength(0);
  });

  it('classifies praise on "highly recommend"', async () => {
    const { gateway } = createMockLLMGateway();
    const result = await classifyReview(
      makeReview({ rating: 5, commentText: 'I highly recommend this team.' }),
      { llmGateway: gateway },
    );
    expect(result.classification).toBe('praise');
    expect(result.source).toBe('regex');
  });
});

describe('P7-026 classifyReview — regex specific complaint', () => {
  it('classifies specific_complaint from "no-show" keyword', async () => {
    const { gateway, provider } = createMockLLMGateway();
    const result = await classifyReview(
      makeReview({ rating: 1, commentText: 'They were a no-show today.' }),
      { llmGateway: gateway },
    );

    expect(result.classification).toBe('specific_complaint');
    expect(result.source).toBe('regex');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(provider.getCalls()).toHaveLength(0);
  });

  it('classifies specific_complaint from "overcharged"', async () => {
    const { gateway } = createMockLLMGateway();
    const result = await classifyReview(
      makeReview({ rating: 1, commentText: 'They overcharged me by $300.' }),
      { llmGateway: gateway },
    );
    expect(result.classification).toBe('specific_complaint');
    expect(result.source).toBe('regex');
  });

  it('prefers specific_complaint when praise + complaint keywords are mixed', async () => {
    // "thanks for the no-show" should NOT be classified as praise.
    const { gateway } = createMockLLMGateway();
    const result = await classifyReview(
      makeReview({
        rating: 1,
        commentText: 'Thanks for the no-show. Great waste of time.',
      }),
      { llmGateway: gateway },
    );
    expect(result.classification).toBe('specific_complaint');
  });
});

describe('P7-026 classifyReview — star-rating shortcuts', () => {
  it('classifies empty-comment 5-star as praise without LLM', async () => {
    const { gateway, provider } = createMockLLMGateway();
    const result = await classifyReview(
      makeReview({ rating: 5, commentText: null }),
      { llmGateway: gateway },
    );
    expect(result.classification).toBe('praise');
    expect(result.source).toBe('regex');
    expect(provider.getCalls()).toHaveLength(0);
  });

  it('classifies empty-comment 1-star as vague_complaint without LLM', async () => {
    const { gateway, provider } = createMockLLMGateway();
    const result = await classifyReview(
      makeReview({ rating: 1, commentText: null }),
      { llmGateway: gateway },
    );
    expect(result.classification).toBe('vague_complaint');
    expect(result.source).toBe('regex');
    expect(provider.getCalls()).toHaveLength(0);
  });

  it('classifies empty-comment 2-star as vague_complaint without LLM', async () => {
    const { gateway, provider } = createMockLLMGateway();
    const result = await classifyReview(
      makeReview({ rating: 2, commentText: '' }),
      { llmGateway: gateway },
    );
    expect(result.classification).toBe('vague_complaint');
    expect(provider.getCalls()).toHaveLength(0);
  });

  it('classifies 5-star with neutral text but no regex hit as praise', async () => {
    // No praise keywords, no complaint keywords. Star rating wins.
    const { gateway, provider } = createMockLLMGateway();
    const result = await classifyReview(
      makeReview({ rating: 5, commentText: 'Got the job done.' }),
      { llmGateway: gateway },
    );
    expect(result.classification).toBe('praise');
    expect(result.source).toBe('regex');
    expect(provider.getCalls()).toHaveLength(0);
  });
});

describe('P7-026 classifyReview — LLM fallback', () => {
  it('uses LLM when regex is inconclusive (3-star, neutral text)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      JSON.stringify({ classification: 'specific_complaint', confidence: 0.9 }),
    );

    const result = await classifyReview(
      makeReview({ rating: 3, commentText: 'The technician arrived 2 hours late.' }),
      { llmGateway: gateway },
    );

    expect(result.classification).toBe('specific_complaint');
    expect(result.source).toBe('llm');
    expect(result.confidence).toBe(0.9);
    expect(provider.getCalls()).toHaveLength(1);
    expect(provider.getCalls()[0].taskType).toBe(REVIEW_CLASSIFY_TASK_TYPE);
  });

  it('falls back to vague_complaint when LLM confidence is below floor', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      JSON.stringify({ classification: 'specific_complaint', confidence: 0.7 }),
    );

    const result = await classifyReview(
      makeReview({ rating: 3, commentText: 'Something felt off about it.' }),
      { llmGateway: gateway },
    );

    expect(result.classification).toBe('vague_complaint');
    expect(result.source).toBe('llm');
    expect(result.confidence).toBe(0.7);
    expect(result.confidence).toBeLessThan(LLM_CONFIDENCE_FLOOR);
  });

  it('returns vague_complaint when LLM returns malformed JSON', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('not json at all');

    const result = await classifyReview(
      makeReview({ rating: 3, commentText: 'Mixed feelings about this visit.' }),
      { llmGateway: gateway },
    );

    expect(result.classification).toBe('vague_complaint');
    expect(result.source).toBe('llm');
  });

  it('returns vague_complaint when LLM returns unknown classification', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse(
      JSON.stringify({ classification: 'neutral', confidence: 0.95 }),
    );

    const result = await classifyReview(
      makeReview({ rating: 3, commentText: 'Mediocre visit overall.' }),
      { llmGateway: gateway },
    );

    expect(result.classification).toBe('vague_complaint');
    expect(result.source).toBe('llm');
  });
});
