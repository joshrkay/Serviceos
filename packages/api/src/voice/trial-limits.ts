export const TRIAL_LIMITS = {
  DAILY_MINUTES: 60,
  TRIAL_TOTAL_MINUTES: 100,
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
  | 'trial_cap_daily'
  | 'trial_cap_total'
  | 'trial_cap_concurrent';

interface TrialCapInput {
  status: SubscriptionStatus;
  dailyMinutes: number;
  trialTotalMinutes: number;
  concurrentCalls: number;
}

export interface TrialCapResult {
  allowed: boolean;
  reason?: GateReason;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function evaluateTrialCap(input: TrialCapInput): TrialCapResult {
  if (input.status !== 'trialing' && input.status !== 'active') {
    return { allowed: false, reason: 'no_billing' };
  }
  if (input.status === 'active') return { allowed: true };

  const dailyCap = envInt('TRIAL_VOICE_MINUTES_DAILY_OVERRIDE', TRIAL_LIMITS.DAILY_MINUTES);
  const totalCap = envInt('TRIAL_VOICE_MINUTES_TOTAL_OVERRIDE', TRIAL_LIMITS.TRIAL_TOTAL_MINUTES);

  if (input.dailyMinutes >= dailyCap) return { allowed: false, reason: 'trial_cap_daily' };
  if (input.trialTotalMinutes >= totalCap) return { allowed: false, reason: 'trial_cap_total' };
  if (input.concurrentCalls >= TRIAL_LIMITS.CONCURRENT_CALLS) {
    return { allowed: false, reason: 'trial_cap_concurrent' };
  }
  return { allowed: true };
}

export const TRIAL_CALL_LIMITS = {
  UPGRADE_NUDGE_CALLS: 15,
  TRIAL_TOTAL_CALLS: 25,
} as const;

export interface TrialCallInput {
  /** Billable calls already completed during this trial. */
  billableCallsUsed: number;
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
    input.billableCallsUsed >= TRIAL_CALL_LIMITS.UPGRADE_NUDGE_CALLS;
  if (input.billableCallsUsed >= TRIAL_CALL_LIMITS.TRIAL_TOTAL_CALLS) {
    return { action: 'forward_to_owner', reason: 'trial_cap_total', upgradeNudgeDue };
  }
  if (input.concurrentCalls >= TRIAL_LIMITS.CONCURRENT_CALLS) {
    return { action: 'forward_to_owner', reason: 'trial_cap_concurrent', upgradeNudgeDue };
  }
  return { action: 'answer', upgradeNudgeDue };
}
