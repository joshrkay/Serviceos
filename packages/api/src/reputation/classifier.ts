/**
 * P7-026 — LLM-backed review classifier.
 *
 * Replaces `classifier-stub.ts`'s heuristic with an LLM gateway call.
 * Routes through `packages/api/src/ai/gateway` per CLAUDE.md
 * ("All AI calls: route through LLM gateway").
 *
 * Returns one of four classifications:
 *   - 'praise'              — positive, 4-5 stars
 *   - 'specific_complaint'  — negative with an actionable detail
 *   - 'vague_complaint'     — negative but no actionable detail
 *   - 'wrong_business'      — reviewer mistook us for another business
 *
 * Failure modes:
 *   - LLM throws → falls back to the heuristic stub. We never crash
 *     the poll worker over a classifier failure; the operator can
 *     re-classify manually if needed.
 *   - LLM returns garbage → falls back to the heuristic.
 *
 * The classification is informational only — it does NOT auto-execute
 * any response. PR-c's build-proposal consumes the classification to
 * decide which sub-drafts (public/private/credit) to include.
 */

import { LLMGateway } from '../ai/gateway/gateway';
import { HeuristicReviewClassifier } from './classifier-stub';
import type { GoogleReview, ReviewClassification } from './types';
import type { ReviewClassifier } from './classifier-stub';

const VALID_CLASSIFICATIONS: readonly ReviewClassification[] = [
  'praise',
  'specific_complaint',
  'vague_complaint',
  'wrong_business',
] as const;

export interface GatewayReviewClassifierDeps {
  gateway: LLMGateway;
  tenantId: string;
  /** Override for tests. Defaults to a HeuristicReviewClassifier. */
  fallback?: ReviewClassifier;
}

export class GatewayReviewClassifier implements ReviewClassifier {
  private readonly fallback: ReviewClassifier;

  constructor(private readonly deps: GatewayReviewClassifierDeps) {
    this.fallback = deps.fallback ?? new HeuristicReviewClassifier();
  }

  async classify(
    review: Pick<GoogleReview, 'rating' | 'commentText'>,
  ): Promise<ReviewClassification> {
    const prompt = buildPrompt(review);
    try {
      const response = await this.deps.gateway.complete({
        taskType: 'review_classification',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        responseFormat: 'json',
        metadata: { tenantId: this.deps.tenantId, skill: 'review_classification' },
      });
      const classification = parseClassification(response.content);
      if (classification) return classification;
    } catch {
      // Fall through to heuristic.
    }
    return this.fallback.classify(review);
  }
}

function buildPrompt(review: Pick<GoogleReview, 'rating' | 'commentText'>): string {
  return `Classify the following Google Business Profile review into one of:
  - "praise"              — overall positive review
  - "specific_complaint"  — negative review that names a specific problem (no-show, late, billing, damage, wrong technician, etc.)
  - "vague_complaint"     — negative review with no actionable detail ("bad service", "would not recommend")
  - "wrong_business"      — reviewer mistook us for a different business or service

Review:
  - rating: ${review.rating} / 5
  - text: ${JSON.stringify((review.commentText ?? '').slice(0, 2000))}

Return ONLY JSON: { "classification": "praise" | "specific_complaint" | "vague_complaint" | "wrong_business" }`;
}

function parseClassification(content: string): ReviewClassification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = (parsed as Record<string, unknown>).classification;
  if (typeof value !== 'string') return null;
  return (VALID_CLASSIFICATIONS as readonly string[]).includes(value)
    ? (value as ReviewClassification)
    : null;
}
