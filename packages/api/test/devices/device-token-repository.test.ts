import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDeviceTokenRepository } from '../../src/devices/device-token-repository';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

describe('InMemoryDeviceTokenRepository', () => {
  let repo: InMemoryDeviceTokenRepository;
  beforeEach(() => {
    repo = new InMemoryDeviceTokenRepository();
  });

  it('registers a token', async () => {
    const d = await repo.register({ tenantId: TENANT_A, userId: 'u1', platform: 'ios', token: 't1' });
    expect(d.id).toBeTruthy();
    expect(await repo.listByTenant(TENANT_A)).toHaveLength(1);
  });

  it('upserts on (tenant, token): re-register updates user/platform/lastSeen, no duplicate', async () => {
    const first = await repo.register({ tenantId: TENANT_A, userId: 'u1', platform: 'ios', token: 't1' });
    const second = await repo.register({ tenantId: TENANT_A, userId: 'u2', platform: 'android', token: 't1' });
    expect(second.id).toBe(first.id);
    const all = await repo.listByTenant(TENANT_A);
    expect(all).toHaveLength(1);
    expect(all[0].userId).toBe('u2');
    expect(all[0].platform).toBe('android');
    expect(all[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
  });

  it('scopes listByTenant by tenant and optional user', async () => {
    await repo.register({ tenantId: TENANT_A, userId: 'u1', platform: 'ios', token: 't1' });
    await repo.register({ tenantId: TENANT_A, userId: 'u2', platform: 'ios', token: 't2' });
    await repo.register({ tenantId: TENANT_B, userId: 'u9', platform: 'ios', token: 't3' });
    expect(await repo.listByTenant(TENANT_A)).toHaveLength(2);
    expect(await repo.listByTenant(TENANT_B)).toHaveLength(1);
    expect(await repo.listByTenant(TENANT_A, 'u1')).toHaveLength(1);
  });

  it('lets the same token string exist under two tenants (unique is per (tenant, token))', async () => {
    await repo.register({ tenantId: TENANT_A, userId: 'u1', platform: 'ios', token: 'shared' });
    await repo.register({ tenantId: TENANT_B, userId: 'u9', platform: 'ios', token: 'shared' });
    expect(await repo.listByTenant(TENANT_A)).toHaveLength(1);
    expect(await repo.listByTenant(TENANT_B)).toHaveLength(1);
  });

  it('deleteToken removes the token and reports whether anything was removed', async () => {
    await repo.register({ tenantId: TENANT_A, userId: 'u1', platform: 'ios', token: 't1' });
    expect(await repo.deleteToken(TENANT_A, 't1')).toBe(true);
    expect(await repo.listByTenant(TENANT_A)).toHaveLength(0);
    expect(await repo.deleteToken(TENANT_A, 'missing')).toBe(false);
  });
});
