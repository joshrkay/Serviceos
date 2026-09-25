export const TRIAL_LIMITS = {
  CONCURRENT_CALLS: 2,
} as const;

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | null;

export type GateReason =
  | 'no_billing'
  | 'not_live'
  | 'e1_script_unreviewed'
  | 'trial_cap_total'
  | 'trial_cap_concurrent'
  | 'overage_cap';

export const TRIAL_MINUTE_LIMITS = {
  UPGRADE_NUDGE_SECONDS: 40 * 60,
  TRIAL_TOTAL_SECONDS: 60 * 60,
} as const;

export interface TrialCallInput {
  /** Billable AI answering seconds already used during this trial. */
  billableSecondsUsed: number;
  concurrentCalls: number;
}

export type TrialCallDecision =
  | { action: 'answer'; upgradeNudgeDue: boolean }
  | {
      /** Over a trial cap: ring the owner rather than leave the caller unanswered. */
      action: 'forward_to_owner';
      reason: 'trial_cap_total' | 'trial_cap_concurrent';
      upgradeNudgeDue: boolean;
    };

export function decideTrialCall(input: TrialCallInput): TrialCallDecision {
  const upgradeNudgeDue =
    input.billableSecondsUsed >= TRIAL_MINUTE_LIMITS.UPGRADE_NUDGE_SECONDS;
  if (input.billableSecondsUsed >= TRIAL_MINUTE_LIMITS.TRIAL_TOTAL_SECONDS) {
    return { action: 'forward_to_owner', reason: 'trial_cap_total', upgradeNudgeDue };
  }
  if (input.concurrentCalls >= TRIAL_LIMITS.CONCURRENT_CALLS) {
    return { action: 'forward_to_owner', reason: 'trial_cap_concurrent', upgradeNudgeDue };
  }
  return { action: 'answer', upgradeNudgeDue };
}
