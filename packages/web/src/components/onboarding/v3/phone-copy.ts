import type { OnboardingStep, PhoneFailureCode } from '../../../types/onboarding';

/**
 * What the number turn shows, from the phone step the API derives
 * (onboarding/derive-status.ts, with the line state from phone-line.ts):
 *   ready    the number is known;
 *   pick     the line is set up and no number is bought until the owner asks;
 *   getting  the line is being set up, or a number is being claimed;
 *   error    the step failed: why, as the API's failure code (null from an
 *            older server that sends only blockers), and that in the owner's words.
 */
export type NumberView =
  | { kind: 'ready'; phoneNumber: string }
  | { kind: 'pick' }
  | { kind: 'getting'; pendingNumber: string | null }
  | { kind: 'error'; code: PhoneFailureCode | null; message: string };

/**
 * Why the number step failed, in the owner's words, by the API's failure code
 * (ProvisioningFailureCodeSchema in the API). Only the area-code line invites a new
 * search; a problem on our side sends the owner to support and promises nothing
 * more, because nothing else is sent anywhere when it happens.
 */
const FAILURE_COPY: Record<PhoneFailureCode, string> = {
  area_code_unavailable: "There were no free numbers where I looked. Pick a different area code and I'll look there.",
  credentials_missing: "That's on our side, not yours. Please contact support and we'll sort it out.",
  provider_error: "I couldn't reach the phone company just now. Try again in a minute.",
  unknown: 'Something went wrong getting your number. Try again.',
};

/** The blocker codes an older server reports without a failure code, in the owner's words: the rule, not the mechanism. */
const BLOCKER_COPY: Record<string, string> = {
  twilio_provisioning_failed: "I couldn't get you a number this time. Try again and I'll look for another.",
  twilio_credentials_missing: "I can't set up phone numbers on your account yet. Please contact support.",
  area_code_unavailable: "There were no free numbers in your area code. Try again and I'll look in the next one.",
  rate_limited: "I've tried a few times already. Give it a minute, then try again.",
};

const COMMON_BLOCKER = 'twilio_provisioning_failed';

/** The failure code decides; without one (an older server) the first blocker does. */
export function phoneBlockerCopy(failureCode: PhoneFailureCode | undefined, blockers: string[] | undefined): string {
  if (failureCode) return FAILURE_COPY[failureCode];
  const code = blockers?.[0] ?? COMMON_BLOCKER;
  return BLOCKER_COPY[code] ?? FAILURE_COPY.unknown;
}

/**
 * What the owner can do about a failure. A taken number (or an area with nothing
 * free) is the only one another number can fix, so it is the only one that looks
 * for one; a problem on our side has nothing to tap; the rest get one Try again.
 * An older server sends no code, and keeps its Try again.
 */
export type FailureAction = 'area_code' | 'none' | 'try_again';

export function failureAction(code: PhoneFailureCode | null): FailureAction {
  if (code === 'area_code_unavailable') return 'area_code';
  if (code === 'credentials_missing') return 'none';
  return 'try_again';
}

/** Said over the next number after the one the owner took was gone by the time it was bought. */
export const TAKEN_OFFER = "That one just went. Here's another.";

export function emptyAreaCodeLine(areaCode: string): string {
  return `There are no free numbers in ${areaCode} right now. Try one nearby.`;
}

/** Why a number search did not work, by the API's error code and status (POST /api/onboarding/phone/available). */
export function numberSearchErrorCopy(status: number, code?: string): string {
  if (code === 'INVALID_AREA_CODE' || status === 400) return 'An area code is three digits, like 216.';
  if (status === 503) return "I can't look up numbers right now. Try again in a minute, or contact support.";
  return "I couldn't look up numbers just now. Try again.";
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function numberView(step: OnboardingStep | undefined): NumberView {
  if (step?.status === 'error') {
    return { kind: 'error', code: step.failureCode ?? null, message: phoneBlockerCopy(step.failureCode, step.blockers) };
  }
  const phoneNumber = text(step?.metadata?.phoneNumber);
  if (phoneNumber) return { kind: 'ready', phoneNumber };
  const lineState = text(step?.metadata?.lineState);
  if (lineState === 'awaiting_pick') return { kind: 'pick' };
  return { kind: 'getting', pendingNumber: lineState === 'claiming' ? text(step?.metadata?.pendingNumber) : null };
}

/** Why asking for a number (or taking the one shown) did not work, by the API's error code and status. */
export function phoneRetryErrorCopy(status: number, code?: string): string {
  if (code === 'PHONE_BILLING_REQUIRED') return 'Your trial has to start before I can get you a number.';
  if (code === 'PHONE_RETRY_NOT_ALLOWED' || code === 'PHONE_CLAIM_NOT_ALLOWED') return "I'm already working on your number. Give me a moment.";
  if (status === 403) return 'Only the owner can do that.';
  if (status === 503) return "I can't get numbers right now. Try again in a minute, or contact support.";
  if (status >= 500) return "I couldn't do that just now. Wait a minute and try again.";
  return "I couldn't do that just now. Try again.";
}
