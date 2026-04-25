import { randomUUID } from 'crypto';

export type CatalogCategory = 'Labor' | 'Parts' | 'Materials';
export type CatalogUnit = 'each' | 'hour' | 'sq ft' | 'per lb' | 'per gal';
export type ProductServiceType = 'product' | 'service';

export interface CatalogItem {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  category: CatalogCategory;
  unit: CatalogUnit;
  unitPriceCents: number;
  productServiceType: ProductServiceType;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCatalogItemInput {
  tenantId: string;
  name: string;
  description?: string;
  category: CatalogCategory;
  unit: CatalogUnit;
  unitPriceCents: number;
}

export interface UpdateCatalogItemInput {
  name?: string;
  description?: string;
  category?: CatalogCategory;
  unit?: CatalogUnit;
  unitPriceCents?: number;
}

export interface ListCatalogItemOptions {
  search?: string;
  category?: CatalogCategory;
  includeArchived?: boolean;
}

export interface CatalogItemRepository {
  create(item: CatalogItem): Promise<CatalogItem>;
  listByTenant(tenantId: string, options?: ListCatalogItemOptions): Promise<CatalogItem[]>;
  findById(tenantId: string, id: string): Promise<CatalogItem | null>;
  update(tenantId: string, id: string, updates: UpdateCatalogItemInput): Promise<CatalogItem | null>;
  archive(tenantId: string, id: string): Promise<boolean>;
}

function inferProductServiceType(category: CatalogCategory): ProductServiceType {
  return category === 'Labor' ? 'service' : 'product';
}

export function createCatalogItem(input: CreateCatalogItemInput): CatalogItem {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    category: input.category,
    unit: input.unit,
    unitPriceCents: input.unitPriceCents,
    productServiceType: inferProductServiceType(input.category),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateCatalogItem(
  repo: CatalogItemRepository,
  tenantId: string,
  id: string,
  updates: UpdateCatalogItemInput
): Promise<CatalogItem | null> {
  const patch: UpdateCatalogItemInput = {
    ...updates,
    name: updates.name?.trim(),
    description: updates.description?.trim(),
  };
  const updated = await repo.update(tenantId, id, patch);
  return updated;
}

export class InMemoryCatalogItemRepository implements CatalogItemRepository {
  private readonly items = new Map<string, CatalogItem>();

  async create(item: CatalogItem): Promise<CatalogItem> {
    this.items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }

  async listByTenant(tenantId: string, options: ListCatalogItemOptions = {}): Promise<CatalogItem[]> {
    const search = options.search?.trim().toLowerCase() ?? '';

    return Array.from(this.items.values())
      .filter((item) => {
        if (item.tenantId !== tenantId) return false;
        if (!options.includeArchived && item.archivedAt) return false;
        if (options.category && item.category !== options.category) return false;
        if (search) {
          const haystack = `${item.name} ${item.description}`.toLowerCase();
          return haystack.includes(search);
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => structuredClone(item));
  }

  async findById(tenantId: string, id: string): Promise<CatalogItem | null> {
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    return structuredClone(item);
  }

  async update(tenantId: string, id: string, updates: UpdateCatalogItemInput): Promise<CatalogItem | null> {
    const current = this.items.get(id);
    if (!current || current.tenantId !== tenantId || current.archivedAt) return null;

    const nextCategory = updates.category ?? current.category;
    const updated: CatalogItem = {
      ...current,
      ...updates,
      category: nextCategory,
      productServiceType: inferProductServiceType(nextCategory),
      updatedAt: new Date().toISOString(),
    };

    this.items.set(id, updated);
    return structuredClone(updated);
  }

  async archive(tenantId: string, id: string): Promise<boolean> {
    const current = this.items.get(id);
    if (!current || current.tenantId !== tenantId || current.archivedAt) return false;

    this.items.set(id, {
      ...current,
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }
}
