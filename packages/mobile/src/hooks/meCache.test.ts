import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrLoadMe, invalidateMeCache } from './meCache';
import type { MeResponse } from '../api/me';

function me(userId: string): MeResponse {
  return {
    user_id: userId,
    tenant_id: 't1',
    role: 'owner',
    can_field_serve: true,
    current_mode: 'supervisor',
    mode_changed_at: null,
    permissions: [],
    backup_supervisor_user_id: null,
    unsupervised_proposal_routing: 'queue_and_sms',
  };
}

afterEach(() => {
  invalidateMeCache();
});

describe('getOrLoadMe', () => {
  it('reuses the in-flight load for the same key (one fetch)', async () => {
    const load = vi.fn().mockResolvedValue(me('u1'));

    const [a, b] = await Promise.all([
      getOrLoadMe('u1', load),
      getOrLoadMe('u1', load),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.user_id).toBe('u1');
  });

  it('reloads when the key changes (different Clerk user)', async () => {
    const load = vi.fn().mockResolvedValueOnce(me('u1')).mockResolvedValueOnce(me('u2'));

    const first = await getOrLoadMe('u1', load);
    const second = await getOrLoadMe('u2', load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(first.user_id).toBe('u1');
    expect(second.user_id).toBe('u2');
  });

  it('clears the cache on error so the next read retries', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(me('u1'));

    await expect(getOrLoadMe('u1', load)).rejects.toThrow('boom');
    const retry = await getOrLoadMe('u1', load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(retry.user_id).toBe('u1');
  });

  it('invalidateMeCache forces a fresh load for the same key', async () => {
    const load = vi.fn().mockResolvedValue(me('u1'));

    await getOrLoadMe('u1', load);
    invalidateMeCache();
    await getOrLoadMe('u1', load);

    expect(load).toHaveBeenCalledTimes(2);
  });
});
