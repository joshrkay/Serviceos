/**
 * Postgres integration — feature flags (PgFeatureFlagRepository).
 *
 * Feature flags are global (not tenant-scoped). The repository lazily creates
 * its own `_feature_flags` table via ensureTable, so this test needs no
 * migration fixtures. Covers the ON CONFLICT upsert, array round-tripping,
 * ordering and delete semantics that the in-memory store can't exercise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { PgFeatureFlagRepository } from '../../src/flags/pg-feature-flags';

// Unique per run so the global table can be shared without cross-test bleed.
const PREFIX = `it_${Math.random().toString(36).slice(2, 8)}_`;

describe('Postgres integration — feature flags', () => {
  let pool: Pool;
  let repo: PgFeatureFlagRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgFeatureFlagRepository(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM _feature_flags WHERE name LIKE $1', [`${PREFIX}%`]).catch(() => undefined);
    await closeSharedTestDb();
  });

  it('lazily creates its table and inserts a flag', async () => {
    const name = `${PREFIX}new_dashboard`;
    const flag = await repo.upsert({ name, enabled: true, description: 'beta dashboard' });
    expect(flag).toEqual({ name, enabled: true, description: 'beta dashboard' });
    expect(await repo.get(name)).toEqual(flag);
  });

  it('upsert updates an existing flag in place (ON CONFLICT)', async () => {
    const name = `${PREFIX}toggle`;
    await repo.upsert({ name, enabled: false });
    const updated = await repo.upsert({ name, enabled: true, description: 'now on' });
    expect(updated.enabled).toBe(true);
    expect(updated.description).toBe('now on');
    const all = (await repo.list()).filter((f) => f.name === name);
    expect(all).toHaveLength(1); // updated, not duplicated
  });

  it('round-trips environments and tenant_ids arrays', async () => {
    const name = `${PREFIX}scoped`;
    await repo.upsert({
      name,
      enabled: true,
      environments: ['staging', 'prod'],
      tenantIds: ['tenant-a', 'tenant-b'],
    });
    const got = await repo.get(name);
    expect(got!.environments).toEqual(['staging', 'prod']);
    expect(got!.tenantIds).toEqual(['tenant-a', 'tenant-b']);
  });

  it('maps NULL arrays back to undefined', async () => {
    const name = `${PREFIX}plain`;
    await repo.upsert({ name, enabled: false });
    const got = await repo.get(name);
    expect(got!.environments).toBeUndefined();
    expect(got!.tenantIds).toBeUndefined();
  });

  it('get returns null for an unknown flag', async () => {
    expect(await repo.get(`${PREFIX}does_not_exist`)).toBeNull();
  });

  it('list returns flags ordered by name ascending', async () => {
    await repo.upsert({ name: `${PREFIX}zeta`, enabled: true });
    await repo.upsert({ name: `${PREFIX}alpha`, enabled: true });
    const names = (await repo.list()).map((f) => f.name).filter((n) => n.startsWith(PREFIX));
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('delete removes a flag and reports whether a row was removed', async () => {
    const name = `${PREFIX}temp`;
    await repo.upsert({ name, enabled: true });
    expect(await repo.delete(name)).toBe(true);
    expect(await repo.get(name)).toBeNull();
    expect(await repo.delete(name)).toBe(false);
  });

  it('rejects a blank flag name', async () => {
    await expect(repo.upsert({ name: '  ', enabled: true })).rejects.toThrow(/name is required/i);
  });
});
