/**
 * Postgres integration — the tenant enumerator every sweep runs on (D-032).
 *
 * `listAllTenantIds` existed as fifteen inlined copies inside app.ts, and every
 * sweep integration test stubbed `listTenantIds` to a hand-picked one-element
 * array — so this query had never executed under test. The stub replaced
 * exactly the thing under test, which is the same shape as the defect CLAUDE.md
 * records (the entity resolver shipped with nonexistent column names because
 * its Pool was mocked).
 *
 * This file runs the real selector against real Postgres. It is the first half
 * of T4; sweep-tenant-fanout.test.ts is the second.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { listAllTenantIds } from '../../src/tenants/list-tenant-ids';

describe('Postgres integration — listAllTenantIds', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('returns every seeded tenant — the production SELECT, against real columns', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    const c = await createTestTenant(pool);

    const ids = await listAllTenantIds(pool);

    // Superset, not equality: the shared container carries tenants seeded by
    // every other integration file. Asserting a count here would make this test
    // fail whenever an unrelated file adds a tenant — a false coupling worse
    // than the gap it closes.
    expect(ids).toEqual(expect.arrayContaining([a.tenantId, b.tenantId, c.tenantId]));
  });

  it('returns ids that are unique and shaped like the tenants.id column', async () => {
    const ids = await listAllTenantIds(pool);

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });

  it('sees a tenant created after an earlier call — no caching between sweeps', async () => {
    const before = await listAllTenantIds(pool);
    const fresh = await createTestTenant(pool);
    const after = await listAllTenantIds(pool);

    expect(before).not.toContain(fresh.tenantId);
    expect(after).toContain(fresh.tenantId);
    expect(after.length).toBe(before.length + 1);
  });

  it('returns [] without a pool instead of throwing — sweeps register before the pool exists', async () => {
    // PROCESS_ROLE=web, in-memory boots and unit runs all register sweeps with
    // no pool. No pool means no tenants to sweep, not a crash at interval time.
    await expect(listAllTenantIds(undefined)).resolves.toEqual([]);
    await expect(listAllTenantIds(null)).resolves.toEqual([]);
  });
});
