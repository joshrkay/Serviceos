/**
 * Tier 4 (Deposit rules — PR 2). Pure rule evaluator.
 *
 * Takes the deposit-relevant slice of TenantSettings plus a contract
 * total in cents and returns the required deposit in cents. The
 * estimate-approval hook in `PublicEstimateService.approve()` calls
 * this once the customer accepts; PR 3's customer payment flow
 * compares `deposit_paid_cents` against the result.
 *
 * Lives under `jobs/` (rather than `settings/`) because the deposit
 * is a property of the job — the unit of work that exists in both
 * the estimate-approval flow and the direct-to-job flow. Tenants
 * with no rule configured get back 0 always; behavior is unchanged
 * for existing tenants on the day this lands.
 */

import type { TenantSettings } from '../settings/settings';
import { applyBps } from '../shared/billing-engine';

export type DepositRuleSettings = Pick<
  TenantSettings,
  'depositStrategy' | 'depositPercentageBps' | 'depositFixedCents' | 'depositRequiredAboveCents'
>;

export type DepositStatus = 'not_required' | 'pending' | 'paid';

/**
 * Compute the required deposit in cents.
 *
 * Returns 0 when:
 *   - the tenant has no rule configured (`depositStrategy` null/undefined),
 *   - the contract total is zero or negative,
 *   - the threshold is set and the total is strictly below it,
 *   - the strategy is set but the matching amount field is missing
 *     (defensive — Zod + the DB CHECK reject this combo on write,
 *     but a stale settings row could land here).
 *
 * Percentage math uses Math.round so cent fractions don't accumulate.
 * Fixed amount is capped at the total — never demand more deposit
 * than the contract is actually worth.
 */
export function evaluateDepositRule(
  settings: DepositRuleSettings,
  totalCents: number,
): number {
  if (!settings.depositStrategy) return 0;
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0;
  if (
    settings.depositRequiredAboveCents != null &&
    totalCents < settings.depositRequiredAboveCents
  ) {
    return 0;
  }
  if (settings.depositStrategy === 'percentage') {
    const bps = settings.depositPercentageBps;
    if (bps == null || bps <= 0) return 0;
    // Percentage-of-money math routed through the shared billing engine's
    // applyBps so the rounding convention matches tax lines exactly; the
    // cap ensures we never demand more deposit than the contract is worth.
    return Math.min(applyBps(totalCents, bps), totalCents);
  }
  if (settings.depositStrategy === 'fixed') {
    const fixed = settings.depositFixedCents;
    if (fixed == null || fixed <= 0) return 0;
    return Math.min(fixed, totalCents);
  }
  return 0;
}

/**
 * Derive the lifecycle status from the two cents columns. Centralized
 * here so writers don't drift on the rule (e.g. setting `pending` when
 * required is 0 — that should always be `not_required`). Use this
 * everywhere `deposit_status` is computed.
 */
export function deriveDepositStatus(
  depositRequiredCents: number,
  depositPaidCents: number,
): DepositStatus {
  if (depositRequiredCents <= 0) return 'not_required';
  if (depositPaidCents >= depositRequiredCents) return 'paid';
  return 'pending';
}

/**
 * Whether a deposit can be collected from the customer right now: it's
 * required and unpaid (`pending`), on a live estimate (not expired, not a
 * dead status). Policy-agnostic on purpose so both the `before_approval`
 * case (deposit owed while the estimate is still `sent`) and the
 * `after_approval` case (deposit owed once the estimate is `accepted`)
 * funnel through one predicate. Centralized here so the public estimate
 * view and the portal projection agree on when to show a "Pay deposit"
 * affordance and never drift.
 */
export function isDepositPayable(
  depositStatus: DepositStatus,
  estimateStatus: string,
  isExpired: boolean,
): boolean {
  if (isExpired) return false;
  if (depositStatus !== 'pending') return false;
  return estimateStatus === 'sent' || estimateStatus === 'accepted';
}
