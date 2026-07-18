/**
 * Unit tests for the catalog item domain: the pure factory, audit-emitting
 * persist/update/archive helpers, the in-memory repository's filter/isolation
 * behavior, and the Zod contract validation (where price/name rules actually
 * live — the factory itself does not validate).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createCatalogItem,
  persistCatalogItem,
  updateCatalogItem,
  archiveCatalogItem,
  InMemoryCatalogItemRepository,
  CatalogItem,
} from '../../src/catalog/catalog-item';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createCatalogItemSchema, updateCatalogItemSchema } from '../../src/shared/contracts';

const TENANT = 'tenant-1';
const ACTOR = { userId: 'user-1', role: 'owner' };

function makeItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    ...createCatalogItem({
      tenantId: TENANT,
      name: 'Drain snake',
      description: 'Heavy duty',
      category: 'Parts',
      unit: 'each',
      unitPriceCents: 4500,
    }),
    ...overrides,
  };
}

describe('createCatalogItem (pure factory)', () => {
  it('trims name and description and defaults missing description to empty', () => {
    const item = createCatalogItem({
      tenantId: TENANT,
      name: '  Faucet  ',
      category: 'Materials',
      unit: 'each',
      unitPriceCents: 100,
    });
    expect(item.name).toBe('Faucet');
    expect(item.description).toBe('');
    expect(item.archivedAt).toBeNull();
  });

  it('infers service for Labor and product for Parts/Materials', () => {
    expect(
      createCatalogItem({ tenantId: TENANT, name: 'Install', category: 'Labor', unit: 'hour', unitPriceCents: 9000 })
        .productServiceType
    ).toBe('service');
    expect(
      createCatalogItem({ tenantId: TENANT, name: 'Pipe', category: 'Parts', unit: 'each', unitPriceCents: 500 })
        .productServiceType
    ).toBe('product');
  });
});

describe('persistCatalogItem audit emission', () => {
  let repo: InMemoryCatalogItemRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryCatalogItemRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('emits catalog_item.created with item metadata when auditRepo provided', async () => {
    const item = makeItem();
    await persistCatalogItem(repo, item, ACTOR, auditRepo);

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('catalog_item.created');
    expect(events[0].entityType).toBe('catalog_item');
    expect(events[0].entityId).toBe(item.id);
    expect(events[0].metadata).toMatchObject({
      name: 'Drain snake',
      category: 'Parts',
      unit: 'each',
      unitPriceCents: 4500,
    });
  });

  it('persists without audit when no auditRepo is supplied', async () => {
    const item = makeItem();
    await persistCatalogItem(repo, item, ACTOR);
    expect(auditRepo.getAll()).toHaveLength(0);
    expect(await repo.findById(TENANT, item.id)).not.toBeNull();
  });
});

describe('updateCatalogItem', () => {
  let repo: InMemoryCatalogItemRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    repo = new InMemoryCatalogItemRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('emits catalog_item.updated listing the changed keys', async () => {
    const item = makeItem();
    await repo.create(item);
    await updateCatalogItem(repo, TENANT, item.id, { unitPriceCents: 5000, name: ' New ' }, ACTOR, auditRepo);

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('catalog_item.updated');
    expect(events[0].metadata).toEqual({ changes: ['unitPriceCents', 'name'] });
    // name is trimmed through the patch.
    expect((await repo.findById(TENANT, item.id))!.name).toBe('New');
  });

  it('does not emit audit when actor is missing', async () => {
    const item = makeItem();
    await repo.create(item);
    await updateCatalogItem(repo, TENANT, item.id, { unitPriceCents: 5000 }, undefined, auditRepo);
    expect(auditRepo.getAll()).toHaveLength(0);
  });

  it('returns null (and emits nothing) when updating an archived item', async () => {
    const item = makeItem();
    await repo.create(item);
    await repo.archive(TENANT, item.id);
    const result = await updateCatalogItem(repo, TENANT, item.id, { unitPriceCents: 1 }, ACTOR, auditRepo);
    expect(result).toBeNull();
    expect(auditRepo.getAll()).toHaveLength(0);
  });
});

describe('archiveCatalogItem', () => {
  let repo: InMemoryCatalogItemRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryCatalogItemRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('emits catalog_item.archived on first archive', async () => {
    const item = makeItem();
    await repo.create(item);
    expect(await archiveCatalogItem(repo, TENANT, item.id, ACTOR, auditRepo)).toBe(true);
    expect(auditRepo.getAll().map((e) => e.eventType)).toEqual(['catalog_item.archived']);
  });

  it('is idempotent — double-archive returns false and emits no second event', async () => {
    const item = makeItem();
    await repo.create(item);
    await archiveCatalogItem(repo, TENANT, item.id, ACTOR, auditRepo);
    expect(await archiveCatalogItem(repo, TENANT, item.id, ACTOR, auditRepo)).toBe(false);
    expect(auditRepo.getAll()).toHaveLength(1);
  });
});

describe('InMemoryCatalogItemRepository.listByTenant filters', () => {
  let repo: InMemoryCatalogItemRepository;

  beforeEach(async () => {
    repo = new InMemoryCatalogItemRepository();
    await repo.create(makeItem({ id: 'a', name: 'Anchor bolt', category: 'Parts' }));
    await repo.create(makeItem({ id: 'b', name: 'Brass fitting', category: 'Materials' }));
    await repo.create(makeItem({ id: 'c', name: 'Anchor labor', category: 'Labor' }));
  });

  it('excludes archived by default and includes them when requested', async () => {
    await repo.archive(TENANT, 'b');
    expect((await repo.listByTenant(TENANT)).map((i) => i.id)).toEqual(['a', 'c']); // sorted by name; 'b' archived
    expect((await repo.listByTenant(TENANT, { includeArchived: true })).map((i) => i.id).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('combines category + search filters with AND', async () => {
    const result = await repo.listByTenant(TENANT, { category: 'Parts', search: 'anchor' });
    expect(result.map((i) => i.id)).toEqual(['a']);
  });

  it('isolates by tenant', async () => {
    await repo.create(makeItem({ id: 'x', tenantId: 'tenant-2', name: 'Foreign' }));
    expect((await repo.listByTenant('tenant-2')).map((i) => i.id)).toEqual(['x']);
    expect((await repo.listByTenant(TENANT)).some((i) => i.id === 'x')).toBe(false);
  });
});

describe('InMemoryCatalogItemRepository.listByTenant limit', () => {
  let repo: InMemoryCatalogItemRepository;

  beforeEach(async () => {
    repo = new InMemoryCatalogItemRepository();
    // Names chosen to sort predictably (name ASC): item-0 .. item-4.
    for (let i = 0; i < 5; i++) {
      await repo.create(makeItem({ id: `i${i}`, name: `item-${i}`, category: 'Parts' }));
    }
  });

  it('returns N of M rows when a limit is given', async () => {
    const result = await repo.listByTenant(TENANT, { limit: 2 });
    expect(result.map((i) => i.id)).toEqual(['i0', 'i1']);
  });

  it('returns every row when limit is omitted (backward compat)', async () => {
    const result = await repo.listByTenant(TENANT);
    expect(result).toHaveLength(5);
  });

  it('composes with category and search filters', async () => {
    await repo.create(makeItem({ id: 'other-cat', name: 'item-x', category: 'Materials' }));
    const result = await repo.listByTenant(TENANT, { category: 'Parts', search: 'item', limit: 2 });
    expect(result.map((i) => i.id)).toEqual(['i0', 'i1']);
    expect(result.every((i) => i.category === 'Parts')).toBe(true);
  });

  it('limit 0 returns no rows', async () => {
    const result = await repo.listByTenant(TENANT, { limit: 0 });
    expect(result).toEqual([]);
  });

  it('limit greater than the row count returns all rows', async () => {
    const result = await repo.listByTenant(TENANT, { limit: 1000 });
    expect(result).toHaveLength(5);
  });
});

describe('createCatalogItemSchema validation (price/name rules live here)', () => {
  const base = { name: 'Pipe', category: 'Parts', unit: 'each', unitPriceCents: 100 };

  it('accepts a valid payload and a zero price', () => {
    expect(createCatalogItemSchema.safeParse(base).success).toBe(true);
    expect(createCatalogItemSchema.safeParse({ ...base, unitPriceCents: 0 }).success).toBe(true);
  });

  it('rejects negative unitPriceCents', () => {
    expect(createCatalogItemSchema.safeParse({ ...base, unitPriceCents: -1 }).success).toBe(false);
  });

  it('rejects a non-integer unitPriceCents', () => {
    expect(createCatalogItemSchema.safeParse({ ...base, unitPriceCents: 99.5 }).success).toBe(false);
  });

  it('rejects an empty/whitespace name', () => {
    expect(createCatalogItemSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
  });

  it('rejects an unknown category', () => {
    expect(createCatalogItemSchema.safeParse({ ...base, category: 'Widgets' }).success).toBe(false);
  });

  it('updateCatalogItemSchema is a partial — empty object is valid', () => {
    expect(updateCatalogItemSchema.safeParse({}).success).toBe(true);
    expect(updateCatalogItemSchema.safeParse({ unitPriceCents: -5 }).success).toBe(false);
  });
});
