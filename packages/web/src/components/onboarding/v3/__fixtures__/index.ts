import { OnboardingDraftSchema, type OnboardingDraft } from '@ai-service-os/shared';
import draftJson from './draft.plumbing-cle.json';

/**
 * A draft captured from the API (assembleTypicalShop for plumbing in Cleveland,
 * nothing staged yet), pinned to the shared contract on load: if the wire shape
 * drifts, every test that uses it fails here rather than rendering stale data.
 */
export const plumbingCleDraft: OnboardingDraft = OnboardingDraftSchema.parse(draftJson);

export const plumbingCleDraftJson: unknown = draftJson;

export function withDraft(patch: Partial<OnboardingDraft>): OnboardingDraft {
  return { ...plumbingCleDraft, ...patch };
}
