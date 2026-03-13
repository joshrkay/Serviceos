import { v4 as uuidv4 } from 'uuid';
import { VerticalType, ServiceCategory } from '../shared/vertical-types';

export interface WordingPreference {
  id: string;
  tenantId: string;
  canonicalPhrase: string;
  preferredPhrase: string;
  frequency: number;
  verticalType?: VerticalType;
  serviceCategory?: ServiceCategory;
  lastSeenAt: Date;
}

export interface WordingPreferenceRepository {
  create(pref: WordingPreference): Promise<WordingPreference>;
  findByTenant(tenantId: string): Promise<WordingPreference[]>;
  findByFilters(tenantId: string, filters: { verticalType?: VerticalType }): Promise<WordingPreference[]>;
  upsert(tenantId: string, canonicalPhrase: string, preferredPhrase: string, verticalType?: VerticalType): Promise<WordingPreference>;
}

export function validateWordingPreference(pref: Partial<WordingPreference>): string[] {
  const errors: string[] = [];
  if (!pref.tenantId) errors.push('tenantId is required');
  if (!pref.canonicalPhrase) errors.push('canonicalPhrase is required');
  if (!pref.preferredPhrase) errors.push('preferredPhrase is required');
  if (pref.canonicalPhrase === pref.preferredPhrase) errors.push('canonicalPhrase and preferredPhrase must differ');
  return errors;
}

export interface WordingDiff {
  original: string;
  revised: string;
}

export function captureWordingPreferences(
  tenantId: string,
  diffs: WordingDiff[],
  verticalType?: VerticalType,
  serviceCategory?: ServiceCategory
): WordingPreference[] {
  const prefMap = new Map<string, { preferred: string; count: number }>();

  for (const diff of diffs) {
    const normalizedOriginal = diff.original.toLowerCase().trim();
    const normalizedRevised = diff.revised.toLowerCase().trim();
    if (normalizedOriginal === normalizedRevised) continue;

    const existing = prefMap.get(normalizedOriginal);
    if (existing) {
      existing.count += 1;
      if (normalizedRevised === existing.preferred.toLowerCase().trim()) {
        existing.count += 1;
      }
    } else {
      prefMap.set(normalizedOriginal, { preferred: diff.revised, count: 1 });
    }
  }

  return Array.from(prefMap.entries()).map(([canonical, data]) => ({
    id: uuidv4(),
    tenantId,
    canonicalPhrase: canonical,
    preferredPhrase: data.preferred,
    frequency: data.count,
    verticalType,
    serviceCategory,
    lastSeenAt: new Date(),
  }));
}

// P4-007B: Get wording context for prompt injection
export interface WordingContext {
  preferences: Array<{ from: string; to: string }>;
}

export async function getWordingContext(
  tenantId: string,
  verticalType: VerticalType | undefined,
  repository: WordingPreferenceRepository
): Promise<WordingContext> {
  const prefs = verticalType
    ? await repository.findByFilters(tenantId, { verticalType })
    : await repository.findByTenant(tenantId);

  const sorted = prefs.sort((a, b) => b.frequency - a.frequency);
  const topPrefs = sorted.slice(0, 20); // Limit for prompt size

  return {
    preferences: topPrefs.map((p) => ({
      from: p.canonicalPhrase,
      to: p.preferredPhrase,
    })),
  };
}

export class InMemoryWordingPreferenceRepository implements WordingPreferenceRepository {
  private prefs: Map<string, WordingPreference> = new Map();

  async create(pref: WordingPreference): Promise<WordingPreference> {
    this.prefs.set(pref.id, { ...pref });
    return { ...pref };
  }

  async findByTenant(tenantId: string): Promise<WordingPreference[]> {
    return Array.from(this.prefs.values())
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({ ...p }));
  }

  async findByFilters(tenantId: string, filters: { verticalType?: VerticalType }): Promise<WordingPreference[]> {
    return Array.from(this.prefs.values())
      .filter((p) => {
        if (p.tenantId !== tenantId) return false;
        if (filters.verticalType && p.verticalType !== filters.verticalType) return false;
        return true;
      })
      .map((p) => ({ ...p }));
  }

  async upsert(tenantId: string, canonicalPhrase: string, preferredPhrase: string, verticalType?: VerticalType): Promise<WordingPreference> {
    const existing = Array.from(this.prefs.values()).find(
      (p) => p.tenantId === tenantId && p.canonicalPhrase === canonicalPhrase
    );
    if (existing) {
      existing.preferredPhrase = preferredPhrase;
      existing.frequency += 1;
      existing.lastSeenAt = new Date();
      this.prefs.set(existing.id, { ...existing });
      return { ...existing };
    }

    const pref: WordingPreference = {
      id: uuidv4(),
      tenantId,
      canonicalPhrase,
      preferredPhrase,
      frequency: 1,
      verticalType,
      lastSeenAt: new Date(),
    };
    this.prefs.set(pref.id, { ...pref });
    return { ...pref };
  }
}
