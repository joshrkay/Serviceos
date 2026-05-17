/**
 * P7-026 — Service-credit tier calculator + 12-month cap enforcement.
 *
 * Two responsibilities:
 *   1. Suggest a credit tier ($25 / $50 / $100, never floats) for a
 *      given review classification + match quality.
 *   2. Enforce the V1 hard cap: $100 per customer per rolling 12 months.
 *
 * Per the dispatch addendum's "Credit cap bypass" risk note, the cap is
 * enforced in TWO places: here (so a draft that would breach the cap is
 * never shown to the operator) AND in the execution handler (so even a
 * manually-edited draft cannot bypass it). Owner approval is in addition
 * to, not instead of, this cap.
 *
 * Money is integer cents per CLAUDE.md. The tiers are 2500 / 5000 /
 * 10000 cents — never declared in dollars to avoid floating-point drift.
 */

import { SERVICE_CREDIT_12MO_CAP_CENTS, type ServiceCreditTier } from './types';
import type { MatchConfidence, ReviewClassification } from './types';
import type { ServiceCreditRepository } from './service-credit-repository';

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

export interface SuggestCreditInput {
  classification: ReviewClassification;
  matchConfidence: MatchConfidence;
  rating: number;
}

/**
 * Pure suggestion logic. Returns 0 for praise / wrong_business / no
 * match — credits are only suggested for negative reviews where we
 * have a high-confidence customer to apply them to.
 */
export function suggestCreditTier(input: SuggestCreditInput): ServiceCreditTier {
  // No credit on praise reviews — there is nothing to apologise for.
  if (input.classification === 'praise') return 0;

  // No credit on a wrong-business review — the reviewer is not our
  // customer; offering them anything would be inappropriate.
  if (input.classification === 'wrong_business') return 0;

  // Without a high-confidence match we cannot reliably apply a credit
  // to the right account. The proposal still drafts a public response;
  // the credit sub-payload is just omitted.
  if (input.matchConfidence !== 'high') return 0;

  // Specific complaints get a higher tier than vague ones — a clear
  // service failure is more deserving of compensation than a thin
  // "would not recommend" rating. 1-star specific → $100; 2-star
  // specific → $50; vague → $25.
  if (input.classification === 'specific_complaint') {
    return input.rating <= 1 ? 10000 : 5000;
  }
  // vague_complaint:
  return 2500;
}

export interface BoundedCreditResult {
  /** The suggested tier, clamped by the remaining 12-month allowance. */
  amountCents: number;
  /** Remaining allowance after this suggestion would land (>= 0). */
  remainingCapCents: number;
  /** Total credits issued to this customer in the trailing 12 months. */
  alreadyIssuedCents: number;
  /** True when the cap caused us to clamp or zero out the suggestion. */
  capApplied: boolean;
}

export interface BoundCreditInput {
  tenantId: string;
  customerId: string;
  proposedAmountCents: number;
  now: Date;
  repo: ServiceCreditRepository;
}

/**
 * Apply the 12-month-per-customer cap. Returns the bounded amount the
 * proposal builder should ship, plus the remaining allowance the UI
 * surfaces alongside the suggestion ("you have $X of $100 left this
 * year for this customer"). Pure I/O query — no mutation.
 */
export async function boundCreditByCap(
  input: BoundCreditInput,
): Promise<BoundedCreditResult> {
  if (input.proposedAmountCents < 0) {
    throw new Error('proposedAmountCents must be non-negative');
  }
  if (!Number.isInteger(input.proposedAmountCents)) {
    throw new Error('proposedAmountCents must be an integer (cents)');
  }
  const since = new Date(input.now.getTime() - TWELVE_MONTHS_MS);
  const alreadyIssued = await input.repo.sumIssuedSince(
    input.tenantId,
    input.customerId,
    since,
  );
  const remainingBeforeSuggestion = Math.max(
    SERVICE_CREDIT_12MO_CAP_CENTS - alreadyIssued,
    0,
  );
  const bounded = Math.min(input.proposedAmountCents, remainingBeforeSuggestion);
  return {
    amountCents: bounded,
    remainingCapCents: Math.max(remainingBeforeSuggestion - bounded, 0),
    alreadyIssuedCents: alreadyIssued,
    capApplied: bounded < input.proposedAmountCents,
  };
}

/**
 * Hard guard used by the execution handler before writing a row to
 * `service_credits`. Throws if the requested issuance would breach
 * the cap (in cents) — the handler then refuses execution. Owner
 * approval cannot bypass the cap.
 */
export async function assertCreditWithinCap(
  input: BoundCreditInput,
): Promise<void> {
  const bounded = await boundCreditByCap(input);
  if (bounded.amountCents < input.proposedAmountCents) {
    throw new Error(
      `Service credit ${input.proposedAmountCents} cents would exceed the ` +
        `12-month per-customer cap (${SERVICE_CREDIT_12MO_CAP_CENTS} cents). ` +
        `Customer has ${bounded.alreadyIssuedCents} cents issued in the last ` +
        `12 months; remaining cap is ${bounded.remainingCapCents + bounded.amountCents} cents.`,
    );
  }
}

export { SERVICE_CREDIT_12MO_CAP_CENTS };
