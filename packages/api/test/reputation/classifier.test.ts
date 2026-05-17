/**
 * P7-026 — Tests for the LLM-backed review classifier and the fallback
 * heuristic. Includes the labeled-fixture set required by the story
 * (>85% accuracy on the curated examples).
 */

import { describe, it, expect } from 'vitest';
import { GatewayReviewClassifier } from '../../src/reputation/classifier';
import { HeuristicReviewClassifier } from '../../src/reputation/classifier-stub';
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import type { ReviewClassification } from '../../src/reputation/types';

/** Minimal stub gateway: returns a canned classification response. */
function gateway(
  respond: (req: LLMRequest) => Partial<LLMResponse>,
): { complete: (req: LLMRequest) => Promise<LLMResponse> } {
  return {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const r = respond(req);
      return {
        content: r.content ?? '',
        model: r.model ?? 'test',
        provider: r.provider ?? 'test',
        tokenUsage: r.tokenUsage ?? { input: 1, output: 1, total: 2 },
        latencyMs: r.latencyMs ?? 0,
      };
    },
  } as unknown as ConstructorParameters<typeof GatewayReviewClassifier>[0]['gateway'];
}

const LABELED_FIXTURES: ReadonlyArray<{
  rating: number;
  text: string;
  label: ReviewClassification;
}> = [
  // praise (4-5 stars)
  { rating: 5, text: 'Excellent service! Carlos arrived on time and fixed it fast.', label: 'praise' },
  { rating: 5, text: 'Great team, very professional.', label: 'praise' },
  { rating: 5, text: 'Highly recommend!', label: 'praise' },
  { rating: 4, text: 'Good work overall, minor issue with paperwork but resolved.', label: 'praise' },
  { rating: 4, text: 'Punctual and clean.', label: 'praise' },

  // specific_complaint (rating <=2 with actionable detail)
  { rating: 1, text: 'Tech never showed up for our scheduled 5pm slot, waited 3 hours.', label: 'specific_complaint' },
  { rating: 1, text: 'Damaged the floor during the install and refused to pay for it.', label: 'specific_complaint' },
  { rating: 2, text: 'Quoted $300 then charged me $800 with no explanation.', label: 'specific_complaint' },
  { rating: 1, text: 'Wrong technician sent out, did not have the right parts at all.', label: 'specific_complaint' },
  { rating: 2, text: 'They left without finishing the leak repair, water still everywhere.', label: 'specific_complaint' },

  // vague_complaint (low rating, low detail)
  { rating: 1, text: 'Awful.', label: 'vague_complaint' },
  { rating: 2, text: 'Would not recommend.', label: 'vague_complaint' },
  { rating: 3, text: 'Mediocre experience.', label: 'vague_complaint' },
  { rating: 1, text: 'Bad service.', label: 'vague_complaint' },
  { rating: 2, text: 'Disappointed.', label: 'vague_complaint' },

  // wrong_business
  { rating: 1, text: 'Wrong business — I never used these guys, must be a different company.', label: 'wrong_business' },
  { rating: 2, text: 'This is not the right shop. The place I went to is on Main St.', label: 'wrong_business' },
];

describe('P7-026 HeuristicReviewClassifier baseline accuracy', () => {
  it('P7-026 achieves >=85% accuracy on the labeled fixture set', async () => {
    const c = new HeuristicReviewClassifier();
    let correct = 0;
    for (const fx of LABELED_FIXTURES) {
      const got = await c.classify({ rating: fx.rating, commentText: fx.text });
      if (got === fx.label) correct++;
    }
    const accuracy = correct / LABELED_FIXTURES.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.85);
  });
});

describe('P7-026 GatewayReviewClassifier', () => {
  it('P7-026 returns the gateway classification when valid', async () => {
    const g = gateway(() => ({
      content: JSON.stringify({ classification: 'specific_complaint' }),
    }));
    const c = new GatewayReviewClassifier({ gateway: g as never, tenantId: 't' });
    const result = await c.classify({ rating: 1, commentText: 'never showed up' });
    expect(result).toBe('specific_complaint');
  });

  it('P7-026 falls back to the heuristic when the gateway returns garbage', async () => {
    const g = gateway(() => ({ content: 'not json at all' }));
    const c = new GatewayReviewClassifier({ gateway: g as never, tenantId: 't' });
    const result = await c.classify({
      rating: 5,
      commentText: 'Amazing job!',
    });
    expect(result).toBe('praise');
  });

  it('P7-026 falls back to the heuristic when the gateway throws', async () => {
    const throwingGateway = {
      async complete(): Promise<never> {
        throw new Error('gateway down');
      },
    };
    const c = new GatewayReviewClassifier({
      gateway: throwingGateway as never,
      tenantId: 't',
    });
    const result = await c.classify({ rating: 1, commentText: 'Awful experience' });
    expect(result).toBe('vague_complaint');
  });

  it('P7-026 rejects an invalid classification value from the gateway', async () => {
    const g = gateway(() => ({
      content: JSON.stringify({ classification: 'invented_label' }),
    }));
    const c = new GatewayReviewClassifier({ gateway: g as never, tenantId: 't' });
    const result = await c.classify({
      rating: 5,
      commentText: 'Great service',
    });
    // Falls back to heuristic — 5-star → praise.
    expect(result).toBe('praise');
  });
});
