import type { OptionCardOption } from '../../ui/option-card';
import { dollars } from './summarize';

/** One sellable plan, as GET /api/onboarding/billing/plans sends it (BillingPlanView in the API). */
export interface BillingPlan {
  id: string;
  name: string;
  amountCents: number;
  currency: string;
  interval: string;
  includedUsers: number;
  /** The API's field name; the owner reads it as answered-call minutes. */
  includedAiMinutes: number;
  overageCentsPerAiMinute: number;
}

const INTERVAL_PHRASE: Record<string, string> = { month: 'a month', year: 'a year', week: 'a week' };

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * A plan as a row the owner can pick. The price is formatted from integer cents
 * at the last moment. No "most shops" mark: the API does not say which plan is
 * the typical one.
 */
export function planOption(plan: BillingPlan): OptionCardOption {
  const period = INTERVAL_PHRASE[plan.interval] ?? `per ${plan.interval}`;
  return {
    key: plan.id,
    label: `${plan.name}, ${dollars(plan.amountCents)} ${period}`,
    detail: `Includes ${count(plan.includedUsers, 'user')} and ${count(plan.includedAiMinutes, 'minute')} of answered calls.`,
  };
}

export const NETWORK_ERROR = "I couldn't reach the checkout. Check your connection and try again.";
export const CHECKOUT_NO_URL = "I couldn't open the checkout page. Try again, or contact support.";

/**
 * The API's own `message` is written to be shown, but some are written for
 * whoever runs the system (variable names, "tenant", "configured"). It is an
 * owner's to read only when it is plain prose: letters, digits and sentence
 * punctuation, no internal words, short.
 */
const PLAIN_PROSE = /^[A-Za-z0-9 .,'?!-]+$/;
const INTERNAL_WORDS = /\b(tenant|environment|configur\w*)\b/i;

function plainMessage(message: string | undefined): string | null {
  const text = message?.trim();
  if (!text || text.length > 140) return null;
  return PLAIN_PROSE.test(text) && !INTERNAL_WORDS.test(text) ? text : null;
}

/**
 * What the owner reads when the plans or the checkout fail. Same cases as the
 * original billing step (503 and 400 carry the API's message, a 5xx is a
 * neutral "try again"), reworded for the owner.
 */
export function trialErrorCopy(kind: 'plans' | 'checkout', status: number, apiMessage?: string): string {
  const what = kind === 'plans' ? "I can't show the plans right now." : "I can't start the checkout right now.";
  // A server fault: whatever its body says is for the logs, not the owner.
  if (status >= 500 && status !== 503) return `${what} Wait a minute and try again.`;
  if (status === 403 && kind === 'checkout') return 'Only the owner can start the trial.';
  const plain = plainMessage(apiMessage);
  if (plain) return plain;
  if (kind === 'plans') return "I can't show the plans right now. Try again in a minute, or contact support.";
  if (status === 503) return "I can't start trials right now. Try again in a minute, or contact support.";
  if (status === 400) return "I couldn't start your trial. Wait a minute and try again, or contact support.";
  return "I couldn't start your trial. Try again, or contact support.";
}
