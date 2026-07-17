/**
 * N-004 (P2-037) — Supervisor Agent review pass: shared types.
 *
 * The reviewer runs four checks (missed-urgency, pricing-anomaly,
 * brand-voice-drift, account-routing) as a second pass between proposal
 * creation and owner dispatch (the AMEND P2-007 pre-SMS chokepoint). Each
 * check returns a {@link CheckResult}; the reviewer aggregates them into a
 * {@link ReviewOutcome} and, in enforce mode, HOLDS the proposal on a
 * customer-harm critical (urgency / routing only).
 */

export type CheckVerdict = 'pass' | 'flag' | 'critical';

export type CheckId =
  | 'missed_urgency'
  | 'pricing_anomaly'
  | 'brand_voice_drift'
  | 'account_routing';

/**
 * Customer-harm checks are the ONLY ones that can HOLD dispatch in enforce
 * mode (owner-decided default). Pricing-anomaly and brand-voice-drift are
 * flag-only in every mode — they never hold and never escalate.
 */
export const CUSTOMER_HARM_CHECKS: readonly CheckId[] = ['missed_urgency', 'account_routing'];

export function isCustomerHarmCheck(id: CheckId): boolean {
  return CUSTOMER_HARM_CHECKS.includes(id);
}

export interface CheckResult {
  id: CheckId;
  verdict: CheckVerdict;
  /** Human-readable reason surfaced as an N-002 marker (only when non-pass). */
  reason?: string;
  /** Structured evidence persisted on supervisor_reviews.checks for the audit/FP harness. */
  evidence?: Record<string, unknown>;
}

/** Rollout flag: off = skip entirely; shadow = compute+log, never hold; enforce = holds active. */
export type SupervisorReviewMode = 'off' | 'shadow' | 'enforce';

export const DEFAULT_SUPERVISOR_REVIEW_MODE: SupervisorReviewMode = 'shadow';

/** Terminal verdict recorded on the supervisor_reviews row. */
export type ReviewVerdict = 'pass' | 'flag' | 'hold' | 'timeout' | 'error';

/** One persisted supervisor review (mirrors migration 242 columns). */
export interface SupervisorReview {
  id: string;
  tenantId: string;
  proposalId: string;
  aiRunId?: string | null;
  model: string;
  verdict: ReviewVerdict;
  critical: boolean;
  checks: Record<string, unknown>;
  flags: string[];
  latencyMs?: number | null;
  shadow: boolean;
  createdAt: Date;
}
