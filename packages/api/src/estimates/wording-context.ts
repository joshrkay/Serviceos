import { ContextBlock, createContextBlock } from '../ai/context-assembly';
import { WordingPreference, WordingPreferenceRepository } from './wording-preference';

export async function buildWordingContextBlock(
  tenantId: string,
  verticalSlug: string,
  repo: WordingPreferenceRepository
): Promise<ContextBlock> {
  const preferences = await repo.findByVertical(tenantId, verticalSlug);
  const content = formatWordingPreferencesForPrompt(preferences);
  return createContextBlock('wording_preferences', 'tenant_preferences', content, 6);
}

export function formatWordingPreferencesForPrompt(preferences: WordingPreference[]): string {
  if (preferences.length === 0) {
    return 'No wording preferences configured.';
  }

  const lines = ['Tenant wording preferences (use preferred phrasing):'];
  for (const pref of preferences) {
    lines.push(`- Instead of "${pref.originalPhrase}", use "${pref.preferredPhrase}"`);
  }
  return lines.join('\n');
}

export function applyWordingPreferences(text: string, preferences: WordingPreference[]): string {
  let result = text;
  for (const pref of preferences) {
    const regex = new RegExp(escapeRegExp(pref.originalPhrase), 'gi');
    result = result.replace(regex, pref.preferredPhrase);
  }
  return result;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
