// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// useApiClient + the native push bindings are mocked, so the real
// registerForPush pipeline runs against controllable deps (no expo-notifications
// loaded — keeps this in the root-only CI lane).
const h = vi.hoisted(() => ({
  api: vi.fn().mockResolvedValue({ ok: true, status: 201 }),
  getPermission: vi.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
  requestPermission: vi.fn().mockResolvedValue({ granted: true }),
  getExpoPushToken: vi.fn().mockResolvedValue('ExponentPushToken[x]'),
}));

vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../push/nativePushDeps', () => ({
  getPermission: h.getPermission,
  requestPermission: h.requestPermission,
  getExpoPushToken: h.getExpoPushToken,
  devicePlatform: 'ios',
}));

// eslint-disable-next-line import/first
import { usePushRegistration } from './usePushRegistration';

beforeEach(() => {
  vi.clearAllMocks();
  h.api.mockResolvedValue({ ok: true, status: 201 });
  h.getPermission.mockResolvedValue({ granted: true, canAskAgain: true });
  h.getExpoPushToken.mockResolvedValue('ExponentPushToken[x]');
});

afterEach(() => cleanup());

describe('usePushRegistration', () => {
  it('registers the device once after sign-in and not again on re-render', async () => {
    const { rerender } = renderHook(({ enabled }) => usePushRegistration(enabled), {
      initialProps: { enabled: true },
    });

    await waitFor(() => expect(h.api).toHaveBeenCalledTimes(1));
    expect(h.api).toHaveBeenCalledWith(
      '/api/devices',
      expect.objectContaining({ method: 'POST' }),
    );

    rerender({ enabled: true });
    await Promise.resolve();
    expect(h.api).toHaveBeenCalledTimes(1); // still once
  });

  it('does not register while signed out (disabled)', async () => {
    renderHook(() => usePushRegistration(false));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.api).not.toHaveBeenCalled();
  });
});
