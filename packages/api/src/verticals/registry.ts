// P4-001A: Vertical Pack Registry
// Manages registration and lookup of vertical packs (HVAC, plumbing, etc.)

import { v4 as uuidv4 } from 'uuid';

export type VerticalType = 'hvac' | 'plumbing';

export interface VerticalPack {
  id: string;
  type: VerticalType;
  name: string;
  version: string;
  description: string;
  isActive: boolean;
  categories: ServiceCategory[];
  terminology: TerminologyMap;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceCategory {
  id: string;
  name: string;
  parentId?: string;
  sortOrder: number;
  description?: string;
}

export interface TerminologyMap {
  [key: string]: {
    displayName: string;
    aliases: string[];
    description?: string;
  };
}

export interface VerticalPackRepository {
  create(pack: VerticalPack): Promise<VerticalPack>;
  findById(id: string): Promise<VerticalPack | null>;
  findByType(type: VerticalType): Promise<VerticalPack | null>;
  findAll(): Promise<VerticalPack[]>;
  findActive(): Promise<VerticalPack[]>;
  update(id: string, updates: Partial<VerticalPack>): Promise<VerticalPack | null>;
}

export function createVerticalPack(
  type: VerticalType,
  name: string,
  version: string,
  description: string,
  categories: ServiceCategory[],
  terminology: TerminologyMap
): VerticalPack {
  return {
    id: uuidv4(),
    type,
    name,
    version,
    description,
    isActive: true,
    categories,
    terminology,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function validateVerticalPack(pack: Partial<VerticalPack>): string[] {
  const errors: string[] = [];
  if (!pack.type) errors.push('type is required');
  if (pack.type && !['hvac', 'plumbing'].includes(pack.type)) {
    errors.push('type must be hvac or plumbing');
  }
  if (!pack.name) errors.push('name is required');
  if (!pack.version) errors.push('version is required');
  if (!pack.categories || pack.categories.length === 0) {
    errors.push('at least one category is required');
  }
  return errors;
}

export function resolveTerminology(
  pack: VerticalPack,
  term: string
): { displayName: string; description?: string } | null {
  const normalizedTerm = term.toLowerCase().trim();

  // Direct key match
  if (pack.terminology[normalizedTerm]) {
    return pack.terminology[normalizedTerm];
  }

  // Alias match
  for (const [_key, entry] of Object.entries(pack.terminology)) {
    if (entry.aliases.some((a) => a.toLowerCase() === normalizedTerm)) {
      return entry;
    }
  }

  return null;
}

export function getCategoryHierarchy(
  pack: VerticalPack,
  categoryId: string
): ServiceCategory[] {
  const result: ServiceCategory[] = [];
  const visited = new Set<string>();
  let current = pack.categories.find((c) => c.id === categoryId);

  while (current) {
    if (visited.has(current.id)) break; // Guard against cyclic parentId
    visited.add(current.id);
    result.unshift(current);
    if (!current.parentId) break;
    current = pack.categories.find((c) => c.id === current!.parentId);
  }

  return result;
}

export function getChildCategories(
  pack: VerticalPack,
  parentId?: string
): ServiceCategory[] {
  return pack.categories
    .filter((c) => c.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function clonePack(p: VerticalPack): VerticalPack {
  return { ...p, categories: p.categories.map((c) => ({ ...c })), terminology: { ...p.terminology } };
}

export class InMemoryVerticalPackRepository implements VerticalPackRepository {
  private packs: Map<string, VerticalPack> = new Map();

  async create(pack: VerticalPack): Promise<VerticalPack> {
    this.packs.set(pack.id, clonePack(pack));
    return clonePack(pack);
  }

  async findById(id: string): Promise<VerticalPack | null> {
    const p = this.packs.get(id);
    return p ? clonePack(p) : null;
  }

  async findByType(type: VerticalType): Promise<VerticalPack | null> {
    for (const p of this.packs.values()) {
      if (p.type === type && p.isActive) return clonePack(p);
    }
    return null;
  }

  async findAll(): Promise<VerticalPack[]> {
    return Array.from(this.packs.values()).map(clonePack);
  }

  async findActive(): Promise<VerticalPack[]> {
    return Array.from(this.packs.values())
      .filter((p) => p.isActive)
      .map(clonePack);
  }

  async update(id: string, updates: Partial<VerticalPack>): Promise<VerticalPack | null> {
    const p = this.packs.get(id);
    if (!p) return null;
    const updated = { ...p, ...updates, updatedAt: new Date() };
    this.packs.set(id, clonePack(updated));
    return clonePack(updated);
  }
}
