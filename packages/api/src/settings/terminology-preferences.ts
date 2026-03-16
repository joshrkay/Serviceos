import { WordingPreference, WordingPreferenceRepository, createWordingPreference } from '../estimates/wording-preference';

export interface TerminologyPreferenceUpdate {
  tenantId: string;
  verticalSlug: string;
  preferences: { originalPhrase: string; preferredPhrase: string }[];
}

export function validateTerminologyPreferenceUpdate(input: TerminologyPreferenceUpdate): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.verticalSlug) errors.push('verticalSlug is required');
  if (!Array.isArray(input.preferences)) errors.push('preferences must be an array');
  if (Array.isArray(input.preferences)) {
    for (const pref of input.preferences) {
      if (!pref.originalPhrase) errors.push('each preference must have an originalPhrase');
      if (!pref.preferredPhrase) errors.push('each preference must have a preferredPhrase');
    }
  }
  return errors;
}

export async function applyTerminologyPreferences(
  update: TerminologyPreferenceUpdate,
  repo: WordingPreferenceRepository
): Promise<WordingPreference[]> {
  const results: WordingPreference[] = [];

  for (const pref of update.preferences) {
    const existing = await repo.findMatch(update.tenantId, pref.originalPhrase);
    if (existing) {
      const updated = {
        ...existing,
        preferredPhrase: pref.preferredPhrase,
        occurrenceCount: existing.occurrenceCount + 1,
        updatedAt: new Date(),
      };
      const saved = await repo.update(updated);
      results.push(saved);
    } else {
      const newPref = createWordingPreference({
        tenantId: update.tenantId,
        verticalSlug: update.verticalSlug,
        originalPhrase: pref.originalPhrase,
        preferredPhrase: pref.preferredPhrase,
        source: 'manual',
      });
      const saved = await repo.create(newPref);
      results.push(saved);
    }
  }

  return results;
}

export async function getTerminologyPreferences(
  tenantId: string,
  verticalSlug: string,
  repo: WordingPreferenceRepository
): Promise<WordingPreference[]> {
  return repo.findByVertical(tenantId, verticalSlug);
}
