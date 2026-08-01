import { describe, it, expect } from 'vitest';
import {
  DEVICE_TOKEN_STALE_AFTER_DAYS,
  InMemoryDeviceTokenService,
  isExpoPushToken,
} from '../../src/devices/device-token';

/**
 * Contract tests for the device push-token seam. The Pg implementation is
 * pinned against real Postgres in
 * test/integration/device-push-tokens.test.ts (real columns + real RLS);
 * these cover the semantics both implementations must share.
 */
describe('isExpoPushToken', () => {
  it('accepts both Expo token spellings and rejects anything else', () => {
    expect(isExpoPushToken('ExponentPushToken[abc123]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[abc123]')).toBe(true);
    expect(isExpoPushToken('  ExpoPushToken[abc123]  ')).toBe(true);
    expect(isExpoPushToken('not-a-token')).toBe(false);
    expect(isExpoPushToken('ExpoPushToken[]')).toBe(false);
    expect(isExpoPushToken(42)).toBe(false);
    expect(isExpoPushToken(undefined)).toBe(false);
  });
});

describe('InMemoryDeviceTokenService', () => {
  const T1 = 'tenant-1';
  const T2 = 'tenant-2';

  it('upsert is idempotent per (tenant, user, token) and refreshes the platform', async () => {
    const repo = new InMemoryDeviceTokenService();
    await repo.upsert(T1, 'user-1', 'ExponentPushToken[aaa]', 'ios');
    await repo.upsert(T1, 'user-1', 'ExponentPushToken[aaa]', 'android');

    const tokens = repo.list(T1, 'user-1');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].platform).toBe('android');
  });

  it('keeps several devices per user', async () => {
    const repo = new InMemoryDeviceTokenService();
    await repo.upsert(T1, 'user-1', 'ExponentPushToken[aaa]', 'ios');
    await repo.upsert(T1, 'user-1', 'ExponentPushToken[bbb]', 'ios');

    expect(repo.list(T1, 'user-1')).toHaveLength(2);
  });

  it('remove deletes only the named token and no-ops on an unknown one', async () => {
    const repo = new InMemoryDeviceTokenService();
    await repo.upsert(T1, 'user-1', 'ExponentPushToken[aaa]', 'ios');
    await repo.upsert(T1, 'user-1', 'ExponentPushToken[bbb]', 'ios');

    await repo.remove(T1, 'user-1', 'ExponentPushToken[aaa]');
    await repo.remove(T1, 'user-1', 'ExponentPushToken[missing]');

    expect(repo.list(T1, 'user-1').map((t) => t.token)).toEqual(['ExponentPushToken[bbb]']);
  });

  it('listByTenant returns every device for the tenant and never another tenant’s', async () => {
    const repo = new InMemoryDeviceTokenService();
    await repo.upsert(T1, 'user-1', 'ExponentPushToken[aaa]', 'ios');
    await repo.upsert(T1, 'user-2', 'ExponentPushToken[bbb]', 'android');
    await repo.upsert(T2, 'user-3', 'ExponentPushToken[ccc]', 'ios');

    const rows = await repo.listByTenant(T1);
    expect(rows.map((r) => r.expoPushToken).sort()).toEqual([
      'ExponentPushToken[aaa]',
      'ExponentPushToken[bbb]',
    ]);
    expect(rows.every((r) => r.expoPushToken !== 'ExponentPushToken[ccc]')).toBe(true);
  });

  it('pruneStale deletes only tokens older than the TTL, scoped to the tenant', async () => {
    const repo = new InMemoryDeviceTokenService();
    await repo.upsert(T1, 'user-1', 'ExponentPushToken[stale]', 'ios');
    await repo.upsert(T1, 'user-1', 'ExponentPushToken[fresh]', 'ios');
    await repo.upsert(T2, 'user-3', 'ExponentPushToken[other]', 'ios');
    const longAgo = new Date(
      Date.now() - (DEVICE_TOKEN_STALE_AFTER_DAYS + 1) * 24 * 60 * 60_000,
    );
    repo.setUpdatedAt(T1, 'user-1', 'ExponentPushToken[stale]', longAgo);
    // Same age, different tenant — must survive a T1 sweep.
    repo.setUpdatedAt(T2, 'user-3', 'ExponentPushToken[other]', longAgo);

    const pruned = await repo.pruneStale(T1, DEVICE_TOKEN_STALE_AFTER_DAYS);

    expect(pruned).toBe(1);
    expect((await repo.listByTenant(T1)).map((r) => r.expoPushToken)).toEqual([
      'ExponentPushToken[fresh]',
    ]);
    expect(await repo.listByTenant(T2)).toHaveLength(1);
  });
});
