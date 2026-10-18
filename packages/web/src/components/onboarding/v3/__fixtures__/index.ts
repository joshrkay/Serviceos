import {
  ONBOARDING_CORE_CHOICE_KEYS,
  OnboardingDraftSchema,
  type OnboardingDraft,
  type StagedOnboardingChoices,
} from '@ai-service-os/shared';
import draftJson from './draft.plumbing-cle.json';

/**
 * A draft captured from the API (assembleTypicalShop for plumbing in Cleveland,
 * nothing staged yet), pinned to the shared contract on load: if the wire shape
 * drifts, every test that uses it fails here rather than rendering stale data.
 */
export const plumbingCleDraft: OnboardingDraft = OnboardingDraftSchema.parse(draftJson);

export function withDraft(patch: Partial<OnboardingDraft>): OnboardingDraft {
  return { ...plumbingCleDraft, ...patch };
}

/**
 * The draft after the owner staged `choices`, the way the API returns it: the
 * new answers are merged over any already staged, and the version moves on once
 * per answer (every PUT bumps it).
 */
export function withChoices(draft: OnboardingDraft, choices: StagedOnboardingChoices): OnboardingDraft {
  return {
    ...draft,
    choices: { ...draft.choices, ...choices },
    version: draft.version + Object.keys(choices).length,
  };
}

/** All seven core choices staged, each as the option most shops pick. */
export const fullyAnsweredDraft: OnboardingDraft = withChoices(
  plumbingCleDraft,
  Object.fromEntries(
    ONBOARDING_CORE_CHOICE_KEYS.map((key) => {
      const choice = plumbingCleDraft.assembled.choices.find((c) => c.settingKey === key);
      return [key, { option: choice?.mostShops ?? 'a' }];
    }),
  ),
);
