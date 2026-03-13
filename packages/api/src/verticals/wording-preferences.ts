// P4-007A/007B: Wording Preferences
// Tenant-level preferences for how estimates and proposals are worded

import { v4 as uuidv4 } from 'uuid';
import { VerticalType } from './registry';

export interface WordingPreference {
  id: string;
  tenantId: string;
  verticalType?: VerticalType;
  scope: WordingScope;
  key: string;
  preferredWording: string;
  avoidWordings: string[];
  context?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type WordingScope =
  | 'line_item_description'
  | 'customer_message'
  | 'internal_note'
  | 'estimate_header'
  | 'estimate_footer';

export interface CreateWordingPreferenceInput {
  tenantId: string;
  verticalType?: VerticalType;
  scope: WordingScope;
  key: string;
  preferredWording: string;
  avoidWordings?: string[];
  context?: string;
}

export interface WordingPreferenceRepository {
  create(pref: WordingPreference): Promise<WordingPreference>;
  findById(tenantId: string, id: string): Promise<WordingPreference | null>;
  findByTenant(tenantId: string): Promise<WordingPreference[]>;
  findByScope(tenantId: string, scope: WordingScope): Promise<WordingPreference[]>;
  findByKey(tenantId: string, key: string): Promise<WordingPreference | null>;
  update(tenantId: string, id: string, updates: Partial<WordingPreference>): Promise<WordingPreference | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export function validateWordingPreferenceInput(input: CreateWordingPreferenceInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.scope) errors.push('scope is required');
  if (!input.key) errors.push('key is required');
  if (!input.preferredWording) errors.push('preferredWording is required');
  const validScopes: WordingScope[] = [
    'line_item_description',
    'customer_message',
    'internal_note',
    'estimate_header',
    'estimate_footer',
  ];
  if (input.scope && !validScopes.includes(input.scope)) {
    errors.push('invalid scope');
  }
  return errors;
}

export async function createWordingPreference(
  input: CreateWordingPreferenceInput,
  repository: WordingPreferenceRepository
): Promise<WordingPreference> {
  const errors = validateWordingPreferenceInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const pref: WordingPreference = {
    id: uuidv4(),
    tenantId: input.tenantId,
    verticalType: input.verticalType,
    scope: input.scope,
    key: input.key,
    preferredWording: input.preferredWording,
    avoidWordings: input.avoidWordings ?? [],
    context: input.context,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return repository.create(pref);
}

export function applyWordingPreferences(
  text: string,
  preferences: WordingPreference[]
): string {
  let result = text;
  for (const pref of preferences) {
    if (!pref.isActive) continue;
    for (const avoid of pref.avoidWordings) {
      // Case-insensitive replacement of avoided wordings
      const regex = new RegExp(escapeRegExp(avoid), 'gi');
      result = result.replace(regex, pref.preferredWording);
    }
  }
  return result;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getWordingGuidelinesForPrompt(
  preferences: WordingPreference[],
  scope: WordingScope
): string {
  const activePrefs = preferences.filter((p) => p.isActive && p.scope === scope);
  if (activePrefs.length === 0) return '';

  const guidelines: string[] = ['Wording guidelines:'];
  for (const pref of activePrefs) {
    let line = `- Use "${pref.preferredWording}" for ${pref.key}`;
    if (pref.avoidWordings.length > 0) {
      line += ` (avoid: ${pref.avoidWordings.map((w) => `"${w}"`).join(', ')})`;
    }
    guidelines.push(line);
  }

  return guidelines.join('\n');
}

export class InMemoryWordingPreferenceRepository implements WordingPreferenceRepository {
  private preferences: Map<string, WordingPreference> = new Map();

  async create(pref: WordingPreference): Promise<WordingPreference> {
    this.preferences.set(pref.id, { ...pref });
    return { ...pref };
  }

  async findById(tenantId: string, id: string): Promise<WordingPreference | null> {
    const p = this.preferences.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    return { ...p };
  }

  async findByTenant(tenantId: string): Promise<WordingPreference[]> {
    return Array.from(this.preferences.values())
      .filter((p) => p.tenantId === tenantId)
      .map((p) => ({ ...p }));
  }

  async findByScope(tenantId: string, scope: WordingScope): Promise<WordingPreference[]> {
    return Array.from(this.preferences.values())
      .filter((p) => p.tenantId === tenantId && p.scope === scope)
      .map((p) => ({ ...p }));
  }

  async findByKey(tenantId: string, key: string): Promise<WordingPreference | null> {
    for (const p of this.preferences.values()) {
      if (p.tenantId === tenantId && p.key === key) return { ...p };
    }
    return null;
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<WordingPreference>
  ): Promise<WordingPreference | null> {
    const p = this.preferences.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    const updated = { ...p, ...updates, updatedAt: new Date() };
    this.preferences.set(id, updated);
    return { ...updated };
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const p = this.preferences.get(id);
    if (!p || p.tenantId !== tenantId) return false;
    this.preferences.delete(id);
    return true;
  }
}
