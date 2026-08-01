/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Pins the new `limit` option on `PgCatalogItemRepository.listByTenant` and
 * `PgUserRepository.findByTenant` against real Postgres: a real SQL `LIMIT`
 * (not a post-fetch JS `.slice`) bounds the row count, and the query's
 * `ORDER BY` (name ASC for catalog, created_at ASC for users) makes the
 * bounded window deterministic — the exact concern CLAUDE.md's "mocked-DB
 * tests are never sufficient" rule flags (a mocked repo can't catch a
 * missing/wrong `ORDER BY` or a non-parameterized `LIMIT`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { createCatalogItem } from '../../src/catalog/catalog-item';
import { PgUserRepository } from '../../src/users/pg-user';

describe('Postgres integration — glossary query limits', () => {
  let pool: Pool;
  let catalogRepo: PgCatalogItemRepository;
  let userRepo: PgUserRepository;
  let tenant: TestTenant;

  const CATALOG_COUNT = 45;
  const USER_COUNT = 45;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    catalogRepo = new PgCatalogItemRepository(pool);
    userRepo = new PgUserRepository(pool);
    tenant = await createTestTenant(pool);

    // Zero-padded names sort deterministically ASC ("item-00" < "item-01" <
    // ... < "item-44"), matching the repo's `ORDER BY name ASC`.
    for (let i = 0; i < CATALOG_COUNT; i++) {
      await catalogRepo.create(
        createCatalogItem({
          tenantId: tenant.tenantId,
          name: `item-${String(i).padStart(2, '0')}`,
          description: 'seeded for LIMIT pinning',
          category: 'Materials',
          unit: 'each',
          unitPriceCents: 100,
        })
      );
    }

    // Explicit, strictly-increasing created_at (rather than relying on
    // NOW() at insert time) so `ORDER BY created_at ASC` is deterministic
    // regardless of how fast the seeding loop runs.
    const base = Date.now();
    for (let i = 0; i < USER_COUNT; i++) {
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name, created_at)
         VALUES ($1, $2, $3, $4, 'technician', $5, $6, $7)`,
        [
          id,
          tenant.tenantId,
          id,
          `user-${i}@example.com`,
          'Tech',
          `${String(i).padStart(2, '0')}`,
          new Date(base + i * 10),
        ]
      );
    }
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('listByTenant(tenant, {limit: 40}) returns exactly 40 rows in name ASC order', async () => {
    const result = await catalogRepo.listByTenant(tenant.tenantId, { limit: 40 });
    expect(result).toHaveLength(40);
    expect(result.map((i) => i.name)).toEqual(
      Array.from({ length: 40 }, (_, i) => `item-${String(i).padStart(2, '0')}`)
    );
  });

  it('listByTenant without a limit returns every row (backward compat)', async () => {
    const result = await catalogRepo.listByTenant(tenant.tenantId);
    expect(result).toHaveLength(CATALOG_COUNT);
  });

  it('findByTenant(tenant, {limit: 40}) returns exactly 40 rows in created_at ASC order', async () => {
    // Scope to the seeded technicians — createTestTenant also seeds an
    // owner row, which would otherwise be an extra, unordered-by-us row.
    const result = await userRepo.findByTenant(tenant.tenantId, { role: 'technician', limit: 40 });
    expect(result).toHaveLength(40);
    expect(result.map((u) => u.lastName)).toEqual(
      Array.from({ length: 40 }, (_, i) => String(i).padStart(2, '0'))
    );
  });

  it('findByTenant without a limit returns every seeded technician row (backward compat)', async () => {
    const result = await userRepo.findByTenant(tenant.tenantId, { role: 'technician' });
    expect(result).toHaveLength(USER_COUNT);
  });
});
