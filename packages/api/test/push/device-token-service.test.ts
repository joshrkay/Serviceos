import { describe, it, expect } from 'vitest';
import {
  InMemoryDeviceTokenRepository,
  isExpoPushToken,
  validateRegisterInput,
} from '../../src/push/device-token-service';

describe('device-token-service', () => {
  it('recognizes valid Expo push tokens and rejects junk', () => {
    expect(isExpoPushToken('ExponentPushToken[abc123]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[xyz]')).toBe(true);
    expect(isExpoPushToken('not-a-token')).toBe(false);
    expect(isExpoPushToken('ExponentPushToken[]')).toBe(false);
    expect(isExpoPushToken('')).toBe(false);
  });

  it('validateRegisterInput requires tenant, user, a valid token, and a known platform', () => {
    expect(
      validateRegisterInput({
        tenantId: 't',
        userId: 'u',
        expoPushToken: 'ExponentPushToken[a]',
        platform: 'ios',
      }),
    ).toEqual([]);

    const errs = validateRegisterInput({ tenantId: '', userId: '', expoPushToken: 'x', platform: 'web' });
    expect(errs).toContain('tenantId is required');
    expect(errs).toContain('userId is required');
    expect(errs.some((e) => e.includes('Expo push token'))).toBe(true);
    expect(errs.some((e) => e.includes('platform'))).toBe(true);
  });

  it('upserts by (tenant, token): a re-register updates the row, never duplicates', async () => {
    const repo = new InMemoryDeviceTokenRepository();
    const a = await repo.register({
      tenantId: 't1',
      userId: 'u1',
      expoPushToken: 'ExponentPushToken[a]',
      platform: 'ios',
    });
    const b = await repo.register({
      tenantId: 't1',
      userId: 'u2',
      expoPushToken: 'ExponentPushToken[a]',
      platform: 'android',
    });
    expect(b.id).toBe(a.id);
    expect(b.userId).toBe('u2');
    expect(b.platform).toBe('android');
    expect(await repo.listByTenant('t1')).toHaveLength(1);
  });

  it('keeps DIFFERENT device tokens isolated by tenant and removes idempotently', async () => {
    const repo = new InMemoryDeviceTokenRepository();
    await repo.register({ tenantId: 't1', userId: 'u1', expoPushToken: 'ExponentPushToken[a]', platform: 'ios' });
    await repo.register({ tenantId: 't2', userId: 'u1', expoPushToken: 'ExponentPushToken[b]', platform: 'ios' });

    expect(await repo.listByTenant('t1')).toHaveLength(1);
    expect(await repo.remove('t1', 'ExponentPushToken[a]')).toBe(true);
    expect(await repo.listByTenant('t1')).toHaveLength(0);
    expect(await repo.listByTenant('t2')).toHaveLength(1); // other tenant untouched
    expect(await repo.remove('t1', 'ExponentPushToken[a]')).toBe(false); // already gone
  });

  it('token-exclusive ownership: re-registering a token under a new tenant evicts the old tenant row', async () => {
    // Prevents the cross-tenant push leak: after an in-session org switch the
    // physical device token must belong only to the newly active tenant, so a
    // later sign-out (a single tenant-scoped DELETE) leaves no stale row that
    // keeps pushing the former tenant's notifications to a signed-out device.
    const repo = new InMemoryDeviceTokenRepository();
    await repo.register({ tenantId: 't1', userId: 'u1', expoPushToken: 'ExponentPushToken[a]', platform: 'ios' });
    await repo.register({ tenantId: 't2', userId: 'u1', expoPushToken: 'ExponentPushToken[a]', platform: 'android' });

    expect(await repo.listByTenant('t1')).toHaveLength(0); // evicted from the old tenant
    const t2 = await repo.listByTenant('t2');
    expect(t2).toHaveLength(1); // owned by the new tenant
    expect(t2[0].platform).toBe('android');
  });
});
