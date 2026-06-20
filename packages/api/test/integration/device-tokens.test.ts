import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgDeviceTokenRepository } from '../../src/push/pg-device-token-repository';

describe('Postgres integration — device tokens', () => {
  let pool: Pool;
  let repo: PgDeviceTokenRepository;
  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgDeviceTokenRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('registers a token and lists it by tenant (real columns)', async () => {
    const d = await repo.register({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      expoPushToken: 'ExponentPushToken[a]',
      platform: 'ios',
    });
    expect(d.id).toBeTruthy();
    expect(d.createdAt).toBeInstanceOf(Date);

    const list = await repo.listByTenant(tenant.tenantId);
    expect(list).toHaveLength(1);
    expect(list[0].expoPushToken).toBe('ExponentPushToken[a]');
    expect(list[0].platform).toBe('ios');
    expect(list[0].userId).toBe(tenant.userId);
  });

  it('upserts on the (tenant, token) unique constraint — updates, never duplicates', async () => {
    const first = await repo.register({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      expoPushToken: 'ExponentPushToken[b]',
      platform: 'ios',
    });
    const second = await repo.register({
      tenantId: tenant.tenantId,
      userId: 'rotated-user',
      expoPushToken: 'ExponentPushToken[b]',
      platform: 'android',
    });
    expect(second.id).toBe(first.id);
    expect(second.userId).toBe('rotated-user');
    expect(second.platform).toBe('android');

    const list = await repo.listByTenant(tenant.tenantId);
    expect(list.filter((t) => t.expoPushToken === 'ExponentPushToken[b]')).toHaveLength(1);
  });

  it('RLS-isolates tokens between tenants (same token string allowed per-tenant)', async () => {
    await repo.register({
      tenantId: other.tenantId,
      userId: other.userId,
      expoPushToken: 'ExponentPushToken[a]',
      platform: 'ios',
    });

    const mine = await repo.listByTenant(tenant.tenantId);
    expect(mine.every((t) => t.tenantId === tenant.tenantId)).toBe(true);

    const theirs = await repo.listByTenant(other.tenantId);
    expect(theirs.every((t) => t.tenantId === other.tenantId)).toBe(true);
    expect(theirs.some((t) => t.expoPushToken === 'ExponentPushToken[a]')).toBe(true);
  });

  it('removes a token idempotently', async () => {
    await repo.register({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      expoPushToken: 'ExponentPushToken[rm]',
      platform: 'ios',
    });
    expect(await repo.remove(tenant.tenantId, 'ExponentPushToken[rm]')).toBe(true);
    expect(await repo.remove(tenant.tenantId, 'ExponentPushToken[rm]')).toBe(false);

    const list = await repo.listByTenant(tenant.tenantId);
    expect(list.some((t) => t.expoPushToken === 'ExponentPushToken[rm]')).toBe(false);
  });
});
