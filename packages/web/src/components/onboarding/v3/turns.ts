/**
 * The choice turns, derived from the draft the server assembled. The turn
 * list is the seven core choices in the order Rivet asks them
 * (ONBOARDING_CORE_CHOICE_KEYS); the established-shop choice is a later slice.
 * A choice counts as answered once it is staged on the draft.
 */
import {
  ONBOARDING_CORE_CHOICE_KEYS,
  type AssembledOnboardingChoice,
  type OnboardingCoreChoiceKey,
  type OnboardingDraft,
} from '@ai-service-os/shared';

export type CoreTurn = AssembledOnboardingChoice & { settingKey: OnboardingCoreChoiceKey };

/** The core choices the draft carries, in registry order. A choice the draft lacks is skipped, never invented. */
export function coreTurns(draft: OnboardingDraft): CoreTurn[] {
  return ONBOARDING_CORE_CHOICE_KEYS.flatMap((key) => {
    const choice = draft.assembled.choices.find((c) => c.settingKey === key);
    return choice ? [{ ...choice, settingKey: key }] : [];
  });
}

function unanswered(draft: OnboardingDraft): OnboardingCoreChoiceKey[] {
  return coreTurns(draft)
    .map((t) => t.settingKey)
    .filter((key) => draft.choices[key] === undefined);
}

export function answeredCount(draft: OnboardingDraft): number {
  return coreTurns(draft).length - unanswered(draft).length;
}

/** Where "Make it mine" lands, and where a returning owner picks up. Null when every turn is answered. */
export function firstUnanswered(draft: OnboardingDraft): OnboardingCoreChoiceKey | null {
  return unanswered(draft)[0] ?? null;
}

/** The next turn still to answer after `key`, or null when that was the last one (the read-back is next). */
export function nextUnanswered(draft: OnboardingDraft, key: OnboardingCoreChoiceKey): OnboardingCoreChoiceKey | null {
  const order = coreTurns(draft).map((t) => t.settingKey);
  const open = new Set(unanswered(draft));
  return order.slice(order.indexOf(key) + 1).find((k) => open.has(k)) ?? null;
}
