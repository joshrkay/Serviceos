import { randomUUID } from 'crypto';
import { AuditRepository, createAuditEvent } from '../audit/audit';

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
  /** Cap the number of rows returned. Omit to return every matching row. */
  limit?: number;
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

// D2-1b: Persist + audit a new catalog item. Keeps `createCatalogItem`
// pure for callers that only need the in-memory shape.
export async function persistCatalogItem(
  repo: CatalogItemRepository,
  item: CatalogItem,
  actor: { userId: string; role: string },
  auditRepo?: AuditRepository
): Promise<CatalogItem> {
  const created = await repo.create(item);

  if (auditRepo) {
    const event = createAuditEvent({
      tenantId: created.tenantId,
      actorId: actor.userId,
      actorRole: actor.role,
      eventType: 'catalog_item.created',
      entityType: 'catalog_item',
      entityId: created.id,
      metadata: {
        name: created.name,
        category: created.category,
        unit: created.unit,
        unitPriceCents: created.unitPriceCents,
      },
    });
    await auditRepo.create(event);
  }

  return created;
}

export async function updateCatalogItem(
  repo: CatalogItemRepository,
  tenantId: string,
  id: string,
  updates: UpdateCatalogItemInput,
  actor?: { userId: string; role: string },
  auditRepo?: AuditRepository
): Promise<CatalogItem | null> {
  const patch: UpdateCatalogItemInput = {
    ...updates,
    name: updates.name?.trim(),
    description: updates.description?.trim(),
  };
  const updated = await repo.update(tenantId, id, patch);

  if (auditRepo && actor && updated) {
    const event = createAuditEvent({
      tenantId,
      actorId: actor.userId,
      actorRole: actor.role,
      eventType: 'catalog_item.updated',
      entityType: 'catalog_item',
      entityId: id,
      metadata: { changes: Object.keys(updates) },
    });
    await auditRepo.create(event);
  }

  return updated;
}

// D2-1b: Soft-delete is "archive" in the repo. Emit catalog_item.archived.
export async function archiveCatalogItem(
  repo: CatalogItemRepository,
  tenantId: string,
  id: string,
  actor?: { userId: string; role: string },
  auditRepo?: AuditRepository
): Promise<boolean> {
  const archived = await repo.archive(tenantId, id);

  if (archived && auditRepo && actor) {
    const event = createAuditEvent({
      tenantId,
      actorId: actor.userId,
      actorRole: actor.role,
      eventType: 'catalog_item.archived',
      entityType: 'catalog_item',
      entityId: id,
      metadata: {},
    });
    await auditRepo.create(event);
  }

  return archived;
}

export class InMemoryCatalogItemRepository implements CatalogItemRepository {
  private readonly items = new Map<string, CatalogItem>();

  async create(item: CatalogItem): Promise<CatalogItem> {
    this.items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }

  async listByTenant(tenantId: string, options: ListCatalogItemOptions = {}): Promise<CatalogItem[]> {
    const search = options.search?.trim().toLowerCase() ?? '';

    const results = Array.from(this.items.values())
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
      // Stable order — must match the pg implementation's `ORDER BY name ASC`
      // so a SQL `LIMIT` window and this in-memory `.slice` agree.
      .sort((a, b) => a.name.localeCompare(b.name));

    const bounded = options.limit !== undefined ? results.slice(0, Math.max(0, options.limit)) : results;
    return bounded.map((item) => structuredClone(item));
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
