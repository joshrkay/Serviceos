import type { OnboardingStep } from '../../../types/onboarding';

/**
 * What the number turn shows, from the phone step the API derives
 * (onboarding/derive-status.ts, with the line state from phone-line.ts):
 *   ready    the number is known;
 *   pick     the line is set up and no number is bought until the owner asks;
 *   getting  the line is being set up, or a number is being claimed;
 *   error    the step failed, with a blocker.
 */
export type NumberView =
  | { kind: 'ready'; phoneNumber: string }
  | { kind: 'pick' }
  | { kind: 'getting'; pendingNumber: string | null }
  | { kind: 'error'; message: string };

/** The blocker codes the number step reports, in the owner's words: the rule, not the mechanism. */
const BLOCKER_COPY: Record<string, string> = {
  twilio_provisioning_failed: "I couldn't get you a number this time. Try again and I'll look for another.",
  twilio_credentials_missing: "I can't set up phone numbers on your account yet. Please contact support.",
  area_code_unavailable: "There were no free numbers in your area code. Try again and I'll look in the next one.",
  rate_limited: "I've tried a few times already. Give it a minute, then try again.",
};

const COMMON_BLOCKER = 'twilio_provisioning_failed';

export function phoneBlockerCopy(blockers: string[] | undefined): string {
  const code = blockers?.[0] ?? COMMON_BLOCKER;
  return BLOCKER_COPY[code] ?? 'Something went wrong getting your number. Try again.';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function numberView(step: OnboardingStep | undefined): NumberView {
  if (step?.status === 'error') return { kind: 'error', message: phoneBlockerCopy(step.blockers) };
  const phoneNumber = text(step?.metadata?.phoneNumber);
  if (phoneNumber) return { kind: 'ready', phoneNumber };
  const lineState = text(step?.metadata?.lineState);
  if (lineState === 'awaiting_pick') return { kind: 'pick' };
  return { kind: 'getting', pendingNumber: lineState === 'claiming' ? text(step?.metadata?.pendingNumber) : null };
}

/** Why asking for a number did not work, by the API's error code and status. */
export function phoneRetryErrorCopy(status: number, code?: string): string {
  if (code === 'PHONE_BILLING_REQUIRED') return 'Your trial has to start before I can get you a number.';
  if (code === 'PHONE_RETRY_NOT_ALLOWED') return "I'm already working on your number. Give me a moment.";
  if (status === 403) return 'Only the owner can do that.';
  if (status === 503) return "I can't get numbers right now. Try again in a minute, or contact support.";
  if (status >= 500) return "I couldn't do that just now. Wait a minute and try again.";
  return "I couldn't do that just now. Try again.";
}
