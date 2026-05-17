/**
 * P7-026 — Heuristic review classifier used by PR-a only.
 *
 * Real LLM-backed classifier lives in `classifier.ts` (added in PR-b).
 * This stub exists so the polling worker is end-to-end runnable in
 * isolation: a poll that found a new review can attach a
 * classification before the proposal-builder lands.
 *
 * Rules are deliberately simple and conservative:
 *   - rating >= 4 → 'praise'
 *   - rating <= 2 with non-empty body of >= 20 chars → 'specific_complaint'
 *   - rating <= 2 otherwise → 'vague_complaint'
 *   - rating === 3 → 'vague_complaint'
 *   - any review mentioning a different business name pattern
 *     (`'wrong business'`, `'not your shop'`) → 'wrong_business'
 *
 * The PR-b classifier will route through the LLM gateway and improve
 * accuracy beyond the >85% threshold the story requires.
 */

import type { GoogleReview, ReviewClassification } from './types';

const WRONG_BUSINESS_PATTERNS = [
  /\bwrong business\b/i,
  /\bnot (your|the right) (shop|business|company)\b/i,
  /\bwrong (place|company|shop)\b/i,
];

export interface ReviewClassifier {
  classify(review: Pick<GoogleReview, 'rating' | 'commentText'>): Promise<ReviewClassification>;
}

export class HeuristicReviewClassifier implements ReviewClassifier {
  async classify(
    review: Pick<GoogleReview, 'rating' | 'commentText'>,
  ): Promise<ReviewClassification> {
    const text = (review.commentText ?? '').trim();

    if (WRONG_BUSINESS_PATTERNS.some((re) => re.test(text))) {
      return 'wrong_business';
    }

    if (review.rating >= 4) return 'praise';

    if (review.rating <= 2 && text.length >= 20) {
      return 'specific_complaint';
    }

    return 'vague_complaint';
  }
}
