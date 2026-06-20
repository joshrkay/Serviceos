// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// useApiClient, Clerk's useAuth, and the native push bindings are mocked, so the
// real registerForPush pipeline runs against controllable deps (no
// expo-notifications loaded — keeps this in the root-only CI lane).
const h = vi.hoisted(() => ({
  api: vi.fn().mockResolvedValue({ ok: true, status: 201 }),
  orgId: 'org_a' as string | null,
  getPermission: vi.fn().mockResolvedValue({ granted: true, canAskAgain: true }),
  requestPermission: vi.fn().mockResolvedValue({ granted: true }),
  getExpoPushToken: vi.fn().mockResolvedValue({ status: 'ok', token: 'ExponentPushToken[x]' }),
}));

vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ orgId: h.orgId }) }));
vi.mock('../push/nativePushDeps', () => ({
  getPermission: h.getPermission,
  requestPermission: h.requestPermission,
  getExpoPushToken: h.getExpoPushToken,
  ensureAndroidChannel: vi.fn().mockResolvedValue(undefined),
  devicePlatform: 'ios',
}));

// eslint-disable-next-line import/first
import { usePushRegistration } from './usePushRegistration';

beforeEach(() => {
  vi.clearAllMocks();
  h.api.mockResolvedValue({ ok: true, status: 201 });
  h.orgId = 'org_a';
  h.getPermission.mockResolvedValue({ granted: true, canAskAgain: true });
  h.getExpoPushToken.mockResolvedValue({ status: 'ok', token: 'ExponentPushToken[x]' });
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

  it('re-registers when the active org/tenant switches without a sign-out', async () => {
    const { rerender } = renderHook(({ enabled }) => usePushRegistration(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(h.api).toHaveBeenCalledTimes(1));

    // Same tenant re-render → no duplicate registration.
    rerender({ enabled: true });
    await Promise.resolve();
    expect(h.api).toHaveBeenCalledTimes(1);

    // Switch org (e.g. the owner changes active organization in-session). The
    // device token must be posted again so it is stored under the new tenant.
    h.orgId = 'org_b';
    rerender({ enabled: true });
    await waitFor(() => expect(h.api).toHaveBeenCalledTimes(2));
  });

  it('retries on the next render after a transient failure (does not latch on error)', async () => {
    h.api = vi.fn().mockResolvedValue({ ok: false, status: 503 }); // transient blip
    const { rerender } = renderHook(() => usePushRegistration(true));
    await waitFor(() => expect(h.api).toHaveBeenCalledTimes(1));
    const failed = h.api;

    // A new api identity (e.g. Clerk refreshed the token) re-runs the effect;
    // because the prior attempt was transient, it retries instead of latching.
    h.api = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    rerender();
    await waitFor(() => expect(h.api).toHaveBeenCalledTimes(1));
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('re-registers after a sign-out → sign-in cycle without a remount', async () => {
    const { rerender } = renderHook(({ enabled }) => usePushRegistration(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(h.api).toHaveBeenCalledTimes(1));

    // Sign out (token revoked elsewhere) then sign back in on the same mount.
    rerender({ enabled: false });
    await Promise.resolve();
    rerender({ enabled: true });

    await waitFor(() => expect(h.api).toHaveBeenCalledTimes(2));
  });
});
