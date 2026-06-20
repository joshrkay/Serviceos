// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  api: vi.fn().mockResolvedValue({ ok: true, status: 204 }),
  signOut: vi.fn().mockResolvedValue(undefined),
  getExpoPushToken: vi.fn().mockResolvedValue('ExponentPushToken[x]'),
}));

vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ signOut: h.signOut }) }));
vi.mock('./nativePushDeps', () => ({ getExpoPushToken: h.getExpoPushToken }));

// eslint-disable-next-line import/first
import { useSignOut } from './useSignOut';

beforeEach(() => {
  vi.clearAllMocks();
  h.api.mockResolvedValue({ ok: true, status: 204 });
  h.getExpoPushToken.mockResolvedValue('ExponentPushToken[x]');
});

afterEach(() => cleanup());

describe('useSignOut', () => {
  it('revokes the device token before signing out', async () => {
    const { result } = renderHook(() => useSignOut());
    await act(async () => {
      await result.current();
    });

    expect(h.api).toHaveBeenCalledWith('/api/devices', expect.objectContaining({ method: 'DELETE' }));
    expect(h.signOut).toHaveBeenCalledTimes(1);
    expect(h.api.mock.invocationCallOrder[0]).toBeLessThan(h.signOut.mock.invocationCallOrder[0]);
  });

  it('still signs out if revocation fails', async () => {
    h.api.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useSignOut());
    await act(async () => {
      await result.current();
    });
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });
});
