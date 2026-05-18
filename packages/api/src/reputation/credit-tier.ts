/**
 * P7-026 PR c — Service-credit tier calculator + 12-month rolling cap.
 *
 * Pure functions only — no I/O, no time, no DB. The caller (the
 * build-proposal orchestrator) injects the prior-issued-cents total it
 * already queried for the customer; the cap helper just does arithmetic.
 *
 * Tier matrix (cents):
 *   praise              → 0       (no credit on positive reviews)
 *   specific_complaint  → 1★ $100 / 2★ $50  / 3-5★ $25
 *   vague_complaint     → 1★ $50  / 2★ $25  / 3-5★ $0
 *
 * Rationale: specific complaints (named grievance: no-show, broken
 * work, etc.) get a higher credit because we can directly attribute
 * the failure. Vague complaints (just "bad" with no detail) get less
 * because we can't be sure we're crediting an actual screwup. Praise
 * gets nothing because there's nothing to remediate.
 *
 * Cap rationale ($100 / 12 months per customer):
 *   The credit is a goodwill gesture, not a refund mechanism. The cap
 *   prevents a serially-disgruntled customer from extracting unbounded
 *   credit by leaving complaint after complaint. If the cap is
 *   exhausted, the credit component is OMITTED from the proposal (set
 *   to null in the payload) — better UX than showing the owner a $0
 *   credit suggestion.
 */

import type { Classification } from './classifier';

export type CreditTierCents = 0 | 2500 | 5000 | 10000; // 0, $25, $50, $100

/**
 * Map (classification, rating) → credit tier in cents.
 *
 * `rating` must be 1..5 (validated upstream when the Review is
 * persisted — the column has a CHECK constraint). We don't re-validate
 * here; out-of-range values fall through to the safe-default $0 tier.
 */
export function creditTierForReview(
  classification: Classification,
  rating: number,
): CreditTierCents {
  if (classification === 'praise') return 0;

  if (classification === 'specific_complaint') {
    if (rating === 1) return 10000;
    if (rating === 2) return 5000;
    if (rating >= 3 && rating <= 5) return 2500;
    return 0;
  }

  // vague_complaint
  if (rating === 1) return 5000;
  if (rating === 2) return 2500;
  return 0;
}

/** Per-customer rolling cap on credit issued in the last 12 months. */
export const CREDIT_CAP_CENTS_PER_12_MONTHS = 10000; // $100

/**
 * Apply the rolling cap to a requested tier.
 *
 * If the requested tier would push the customer's 12-month rolling
 * total over the cap, returns 0 (the build-proposal orchestrator then
 * OMITS the serviceCredit component entirely — sets it to `null`).
 *
 * If the request itself is 0, returns 0 unchanged.
 *
 * Edge case: a request that lands EXACTLY at the cap is allowed
 * (`priorIssuedCents + requestedTier === cap`). Only strict overflow
 * is blocked.
 */
export function applyCreditCap(
  requestedTier: CreditTierCents,
  priorIssuedCents: number,
): CreditTierCents {
  if (requestedTier === 0) return 0;
  if (priorIssuedCents + requestedTier > CREDIT_CAP_CENTS_PER_12_MONTHS) return 0;
  return requestedTier;
}
