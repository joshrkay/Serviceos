import { v4 as uuidv4 } from 'uuid';
import { LineItem } from './estimate';

export interface WordingPreference {
  id: string;
  tenantId: string;
  verticalSlug: string;
  originalPhrase: string;
  preferredPhrase: string;
  occurrenceCount: number;
  source: 'manual' | 'learned';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWordingPreferenceInput {
  tenantId: string;
  verticalSlug: string;
  originalPhrase: string;
  preferredPhrase: string;
  source: 'manual' | 'learned';
}

export interface WordingPreferenceRepository {
  create(pref: WordingPreference): Promise<WordingPreference>;
  findByTenant(tenantId: string): Promise<WordingPreference[]>;
  findByVertical(tenantId: string, verticalSlug: string): Promise<WordingPreference[]>;
  findMatch(tenantId: string, phrase: string): Promise<WordingPreference | null>;
  update(pref: WordingPreference): Promise<WordingPreference>;
}

export function validateWordingPreferenceInput(input: CreateWordingPreferenceInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.verticalSlug) errors.push('verticalSlug is required');
  if (!input.originalPhrase) errors.push('originalPhrase is required');
  if (!input.preferredPhrase) errors.push('preferredPhrase is required');
  if (!input.source) errors.push('source is required');
  return errors;
}

export function createWordingPreference(input: CreateWordingPreferenceInput): WordingPreference {
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    verticalSlug: input.verticalSlug,
    originalPhrase: input.originalPhrase,
    preferredPhrase: input.preferredPhrase,
    occurrenceCount: 1,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
}

export function findMatchingPreference(
  text: string,
  preferences: WordingPreference[]
): WordingPreference | null {
  const lower = text.toLowerCase();
  for (const pref of preferences) {
    if (lower.includes(pref.originalPhrase.toLowerCase())) {
      return pref;
    }
  }
  return null;
}

export function learnWordingFromEdits(
  originalLineItems: LineItem[],
  editedLineItems: LineItem[],
  tenantId: string,
  verticalSlug: string
): WordingPreference[] {
  const preferences: WordingPreference[] = [];

  for (let i = 0; i < Math.min(originalLineItems.length, editedLineItems.length); i++) {
    const original = originalLineItems[i].description;
    const edited = editedLineItems[i].description;

    if (original !== edited && original.length > 0 && edited.length > 0) {
      preferences.push(
        createWordingPreference({
          tenantId,
          verticalSlug,
          originalPhrase: original,
          preferredPhrase: edited,
          source: 'learned',
        })
      );
    }
  }

  return preferences;
}

export class InMemoryWordingPreferenceRepository implements WordingPreferenceRepository {
  private preferences: Map<string, WordingPreference> = new Map();

  async create(pref: WordingPreference): Promise<WordingPreference> {
    this.preferences.set(pref.id, { ...pref });
    return { ...pref };
  }

  async findByTenant(tenantId: string): Promise<WordingPreference[]> {
    return Array.from(this.preferences.values())
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({ ...p }));
  }

  async findByVertical(tenantId: string, verticalSlug: string): Promise<WordingPreference[]> {
    return Array.from(this.preferences.values())
      .filter((p) => p.tenantId === tenantId && p.verticalSlug === verticalSlug)
      .map((p) => ({ ...p }));
  }

  async findMatch(tenantId: string, phrase: string): Promise<WordingPreference | null> {
    const lower = phrase.toLowerCase();
    for (const pref of this.preferences.values()) {
      if (pref.tenantId === tenantId && pref.originalPhrase.toLowerCase() === lower) {
        return { ...pref };
      }
    }
    return null;
  }

  async update(pref: WordingPreference): Promise<WordingPreference> {
    this.preferences.set(pref.id, { ...pref });
    return { ...pref };
  }
}
