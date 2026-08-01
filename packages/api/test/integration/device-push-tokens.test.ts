/**
 * Postgres integration — device push tokens (`device_push_tokens`, migration
 * 196) through PgDeviceTokenRepository.
 *
 * The repo previously ran as an inline object issuing raw `pool.query` calls
 * with no tenant GUC; every column name and the ON CONFLICT target were
 * unverified. This pins them against the real table: the unique index, the
 * `updated_at` refresh on re-registration, tenant scoping of listByTenant, and
 * the interval arithmetic in the TTL sweep.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgDeviceTokenRepository } from '../../src/devices/pg-device-token';
import { DEVICE_TOKEN_STALE_AFTER_DAYS } from '../../src/devices/device-token';

describe('Postgres integration — device push tokens', () => {
  let pool: Pool;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };
  let repo: PgDeviceTokenRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    repo = new PgDeviceTokenRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('upsert inserts once and refreshes platform + updated_at on re-registration', async () => {
    const token = 'ExponentPushToken[int-upsert]';
    await repo.upsert(tenantA.tenantId, tenantA.userId, token, 'ios');

    const first = await pool.query(
      `SELECT platform, updated_at FROM device_push_tokens
        WHERE tenant_id = $1 AND clerk_user_id = $2 AND expo_push_token = $3`,
      [tenantA.tenantId, tenantA.userId, token],
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].platform).toBe('ios');

    // Backdate so the ON CONFLICT ... updated_at = NOW() bump is observable.
    await pool.query(
      `UPDATE device_push_tokens SET updated_at = NOW() - INTERVAL '1 day'
        WHERE tenant_id = $1 AND expo_push_token = $2`,
      [tenantA.tenantId, token],
    );
    await repo.upsert(tenantA.tenantId, tenantA.userId, token, 'android');

    const second = await pool.query(
      `SELECT platform, updated_at FROM device_push_tokens
        WHERE tenant_id = $1 AND clerk_user_id = $2 AND expo_push_token = $3`,
      [tenantA.tenantId, tenantA.userId, token],
    );
    // Still ONE row — the unique index made this an update, not a duplicate.
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].platform).toBe('android');
    expect(new Date(second.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(first.rows[0].updated_at).getTime() - 24 * 60 * 60_000,
    );
  });

  it('listByTenant returns the tenant’s devices only', async () => {
    await repo.upsert(tenantA.tenantId, tenantA.userId, 'ExponentPushToken[int-a1]', 'ios');
    await repo.upsert(tenantA.tenantId, 'other-user', 'ExponentPushToken[int-a2]', 'android');
    await repo.upsert(tenantB.tenantId, tenantB.userId, 'ExponentPushToken[int-b1]', 'ios');

    const rowsA = await repo.listByTenant(tenantA.tenantId);
    const tokensA = rowsA.map((r) => r.expoPushToken);
    expect(tokensA).toEqual(expect.arrayContaining([
      'ExponentPushToken[int-a1]',
      'ExponentPushToken[int-a2]',
    ]));
    expect(tokensA).not.toContain('ExponentPushToken[int-b1]');
    // The mapped shape carries the real column values.
    const a2 = rowsA.find((r) => r.expoPushToken === 'ExponentPushToken[int-a2]');
    expect(a2).toMatchObject({ clerkUserId: 'other-user', platform: 'android' });

    const rowsB = await repo.listByTenant(tenantB.tenantId);
    expect(rowsB.map((r) => r.expoPushToken)).toEqual(['ExponentPushToken[int-b1]']);
  });

  it('remove deletes the named token and no-ops on an unknown one', async () => {
    const token = 'ExponentPushToken[int-remove]';
    await repo.upsert(tenantA.tenantId, tenantA.userId, token, 'ios');

    await repo.remove(tenantA.tenantId, tenantA.userId, token);
    await repo.remove(tenantA.tenantId, tenantA.userId, 'ExponentPushToken[int-missing]');

    const rows = await repo.listByTenant(tenantA.tenantId);
    expect(rows.map((r) => r.expoPushToken)).not.toContain(token);
  });

  it('pruneStale deletes only rows past the TTL, scoped to the tenant', async () => {
    const stale = 'ExponentPushToken[int-stale]';
    const fresh = 'ExponentPushToken[int-fresh]';
    const otherTenant = 'ExponentPushToken[int-stale-b]';
    await repo.upsert(tenantA.tenantId, tenantA.userId, stale, 'ios');
    await repo.upsert(tenantA.tenantId, tenantA.userId, fresh, 'ios');
    await repo.upsert(tenantB.tenantId, tenantB.userId, otherTenant, 'ios');
    await pool.query(
      `UPDATE device_push_tokens
          SET updated_at = NOW() - INTERVAL '200 days'
        WHERE expo_push_token = ANY($1::text[])`,
      [[stale, otherTenant]],
    );

    const pruned = await repo.pruneStale(tenantA.tenantId, DEVICE_TOKEN_STALE_AFTER_DAYS);

    expect(pruned).toBe(1);
    const remainingA = (await repo.listByTenant(tenantA.tenantId)).map((r) => r.expoPushToken);
    expect(remainingA).not.toContain(stale);
    expect(remainingA).toContain(fresh);
    // Another tenant's equally-old row is untouched by a tenant-scoped sweep.
    expect((await repo.listByTenant(tenantB.tenantId)).map((r) => r.expoPushToken)).toContain(
      otherTenant,
    );
  });
});
