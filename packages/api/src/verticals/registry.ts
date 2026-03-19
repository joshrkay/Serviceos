import { randomUUID } from 'crypto';
import {
  InMemoryVerticalPackRegistry,
  VerticalPack as CanonicalVerticalPack,
  VerticalPackRegistry,
} from '../shared/vertical-pack-registry';
import { PackStatus, VerticalType } from '../shared/vertical-types';

export { VerticalType };

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

export interface VerticalPack extends CanonicalVerticalPack {
  type: VerticalType;
  name: string;
  isActive: boolean;
  categories: ServiceCategory[];
  terminology: TerminologyMap;
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
  const now = new Date();
  return {
    id: randomUUID(),
    packId: `${type}-pack`,
    version,
    verticalType: type,
    status: 'active',
    displayName: name,
    description,
    metadata: {
      categories,
      terminology,
    },
    createdAt: now,
    updatedAt: now,
    type,
    name,
    isActive: true,
    categories,
    terminology,
  };
}

export function validateVerticalPack(pack: Partial<VerticalPack>): string[] {
  const errors: string[] = [];
  if (!pack.verticalType && !pack.type) errors.push('verticalType is required');
  const type = pack.verticalType || pack.type;
  if (type && !['hvac', 'plumbing'].includes(type)) {
    errors.push('verticalType must be hvac or plumbing');
  }
  if (!pack.displayName && !pack.name) errors.push('displayName is required');
  if (!pack.version) errors.push('version is required');
  const categories = pack.categories || (pack.metadata as any)?.categories;
  if (!categories || categories.length === 0) {
    errors.push('at least one category is required');
  }
  return errors;
}

function readCategories(pack: Pick<VerticalPack, 'categories' | 'metadata'>): ServiceCategory[] {
  const metadataCategories = (pack.metadata as Record<string, unknown> | undefined)?.categories as
    | ServiceCategory[]
    | undefined;
  return pack.categories?.length ? pack.categories : metadataCategories || [];
}

function readTerminology(pack: Pick<VerticalPack, 'terminology' | 'metadata'>): TerminologyMap {
  const metadataTerminology = (pack.metadata as Record<string, unknown> | undefined)?.terminology as
    | TerminologyMap
    | undefined;
  return (pack.terminology && Object.keys(pack.terminology).length > 0)
    ? pack.terminology
    : (metadataTerminology || {});
}

export function resolveTerminology(
  pack: VerticalPack,
  term: string
): { displayName: string; description?: string } | null {
  const normalizedTerm = term.toLowerCase().trim();
  const terminology = readTerminology(pack);

  if (terminology[normalizedTerm]) {
    return terminology[normalizedTerm];
  }

  for (const entry of Object.values(terminology)) {
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
  const categories = readCategories(pack);
  const result: ServiceCategory[] = [];
  const visited = new Set<string>();
  let current = categories.find((c) => c.id === categoryId);

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    result.unshift(current);
    if (!current.parentId) break;
    current = categories.find((c) => c.id === current!.parentId);
  }

  return result;
}

export function getChildCategories(
  pack: VerticalPack,
  parentId?: string
): ServiceCategory[] {
  const categories = readCategories(pack);
  return categories
    .filter((c) => c.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function clonePack(pack: VerticalPack): VerticalPack {
  return {
    ...pack,
    categories: pack.categories.map((c) => ({ ...c })),
    terminology: { ...pack.terminology },
    metadata: pack.metadata ? { ...pack.metadata } : undefined,
  };
}

function toStatus(isActive: boolean): PackStatus {
  return isActive ? 'active' : 'deprecated';
}

function fromCanonical(pack: CanonicalVerticalPack): VerticalPack {
  const metadata = (pack.metadata || {}) as Record<string, unknown>;
  const categories = (metadata.categories as ServiceCategory[] | undefined) || [];
  const terminology = (metadata.terminology as TerminologyMap | undefined) || {};

  return {
    ...pack,
    type: pack.verticalType,
    name: pack.displayName,
    isActive: pack.status === 'active',
    categories,
    terminology,
  };
}

function toCanonical(pack: VerticalPack): CanonicalVerticalPack {
  return {
    id: pack.id,
    packId: pack.packId,
    version: pack.version,
    verticalType: pack.verticalType || pack.type,
    status: pack.status || toStatus(pack.isActive),
    displayName: pack.displayName || pack.name,
    description: pack.description,
    metadata: {
      ...(pack.metadata || {}),
      categories: pack.categories,
      terminology: pack.terminology,
    },
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt,
  };
}

export class InMemoryVerticalPackRepository implements VerticalPackRepository {
  constructor(private readonly registry: VerticalPackRegistry = new InMemoryVerticalPackRegistry()) {}

  async create(pack: VerticalPack): Promise<VerticalPack> {
    const created = await this.registry.register(toCanonical(pack));
    return clonePack(fromCanonical(created));
  }

  async findById(id: string): Promise<VerticalPack | null> {
    const found = await this.registry.get(id);
    return found ? clonePack(fromCanonical(found)) : null;
  }

  async findByType(type: VerticalType): Promise<VerticalPack | null> {
    const candidates = await this.registry.findByVertical(type);
    const active = candidates.find((pack) => pack.status === 'active');
    return active ? clonePack(fromCanonical(active)) : null;
  }

  async findAll(): Promise<VerticalPack[]> {
    const packs = await this.registry.list();
    return packs.map((pack) => clonePack(fromCanonical(pack)));
  }

  async findActive(): Promise<VerticalPack[]> {
    const packs = await this.registry.list();
    return packs
      .filter((pack) => pack.status === 'active')
      .map((pack) => clonePack(fromCanonical(pack)));
  }

  async update(id: string, updates: Partial<VerticalPack>): Promise<VerticalPack | null> {
    const status =
      updates.status ||
      (updates.isActive !== undefined ? toStatus(updates.isActive) : undefined);

    const updated = await this.registry.update(id, {
      ...updates,
      verticalType: updates.verticalType || updates.type,
      displayName: updates.displayName || updates.name,
      status,
      metadata: updates.categories || updates.terminology
        ? {
          ...(updates.metadata || {}),
          ...(updates.categories ? { categories: updates.categories } : {}),
          ...(updates.terminology ? { terminology: updates.terminology } : {}),
        }
        : updates.metadata,
      updatedAt: new Date(),
    });

    return updated ? clonePack(fromCanonical(updated)) : null;
  }
}
