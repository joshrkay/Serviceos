/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Covers PgCatalogItemRepository against real Postgres + RLS: tenant isolation,
 * the default archived_at IS NULL filter, includeArchived, combined
 * search + category filters, and archive idempotency.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { createCatalogItem, CatalogCategory, CatalogUnit } from '../../src/catalog/catalog-item';

describe('Postgres integration — catalog', () => {
  let pool: Pool;
  let repo: PgCatalogItemRepository;
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCatalogItemRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seed(
    tenantId: string,
    name: string,
    category: CatalogCategory,
    unit: CatalogUnit = 'each',
    priceCents = 1000,
  ) {
    return repo.create(
      createCatalogItem({ tenantId, name, description: `${name} desc`, category, unit, unitPriceCents: priceCents }),
    );
  }

  it('isolates catalog items by tenant under RLS', async () => {
    await seed(tenant.tenantId, 'Tenant-A pipe', 'Parts');
    const otherList = await repo.listByTenant(other.tenantId);
    expect(otherList.some((i) => i.name === 'Tenant-A pipe')).toBe(false);
  });

  it('excludes archived by default and includes them when requested', async () => {
    const item = await seed(tenant.tenantId, 'Archivable widget', 'Materials');
    expect(await repo.archive(tenant.tenantId, item.id)).toBe(true);

    const active = await repo.listByTenant(tenant.tenantId);
    expect(active.some((i) => i.id === item.id)).toBe(false);

    const all = await repo.listByTenant(tenant.tenantId, { includeArchived: true });
    expect(all.some((i) => i.id === item.id)).toBe(true);
  });

  it('combines search + category filters with AND', async () => {
    await seed(tenant.tenantId, 'Copper anchor', 'Parts');
    await seed(tenant.tenantId, 'Copper sealant', 'Materials');
    const result = await repo.listByTenant(tenant.tenantId, { search: 'copper', category: 'Parts' });
    expect(result.every((i) => i.category === 'Parts')).toBe(true);
    expect(result.some((i) => i.name === 'Copper anchor')).toBe(true);
    expect(result.some((i) => i.name === 'Copper sealant')).toBe(false);
  });

  it('archive is idempotent — a second archive returns false', async () => {
    const item = await seed(tenant.tenantId, 'Double archive', 'Labor', 'hour');
    expect(await repo.archive(tenant.tenantId, item.id)).toBe(true);
    expect(await repo.archive(tenant.tenantId, item.id)).toBe(false);
  });

  it('EE-4 — persists and round-trips image_file_id (real column)', async () => {
    const fileId = crypto.randomUUID();
    const created = await repo.create(
      createCatalogItem({
        tenantId: tenant.tenantId,
        name: 'Water heater (photo)',
        category: 'Materials',
        unit: 'each',
        unitPriceCents: 90000,
        imageFileId: fileId,
      }),
    );
    expect(created.imageFileId).toBe(fileId);

    const found = await repo.findById(tenant.tenantId, created.id);
    expect(found?.imageFileId).toBe(fileId);

    // Replace, then clear.
    const newFileId = crypto.randomUUID();
    const replaced = await repo.update(tenant.tenantId, created.id, { imageFileId: newFileId });
    expect(replaced?.imageFileId).toBe(newFileId);
    const cleared = await repo.update(tenant.tenantId, created.id, { imageFileId: null });
    expect(cleared?.imageFileId).toBeNull();
  });

  it('EE-4 — defaults image_file_id to null when unset', async () => {
    const item = await seed(tenant.tenantId, 'No-photo item', 'Parts');
    const found = await repo.findById(tenant.tenantId, item.id);
    expect(found?.imageFileId).toBeNull();
  });
});
