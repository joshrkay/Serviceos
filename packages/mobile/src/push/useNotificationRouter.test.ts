// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  lastData: undefined as Record<string, unknown> | undefined,
  responseCb: undefined as ((d: unknown) => void) | undefined,
  foregroundCb: undefined as (() => void) | undefined,
  responseRemove: vi.fn(),
  foregroundRemove: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('./nativeNotificationDeps', () => ({
  getLastNotificationData: () => Promise.resolve(h.lastData),
  addResponseListener: (cb: (d: unknown) => void) => {
    h.responseCb = cb;
    return { remove: h.responseRemove };
  },
  addForegroundListener: (cb: () => void) => {
    h.foregroundCb = cb;
    return { remove: h.foregroundRemove };
  },
}));

// eslint-disable-next-line import/first
import { useNotificationRouter } from './useNotificationRouter';

beforeEach(() => {
  vi.clearAllMocks();
  h.lastData = undefined;
  h.responseCb = undefined;
  h.foregroundCb = undefined;
});

afterEach(() => cleanup());

describe('useNotificationRouter', () => {
  it('cold start: opens the proposal from the launch notification', async () => {
    h.lastData = { proposalId: 'p1', kind: 'needs_approval' };
    renderHook(() => useNotificationRouter());
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/proposals/p1'));
  });

  it('does not navigate on cold start without a launch notification', async () => {
    renderHook(() => useNotificationRouter());
    await new Promise((r) => setTimeout(r, 0));
    expect(h.push).not.toHaveBeenCalled();
  });

  it('a tap while running deep-links to the proposal', async () => {
    renderHook(() => useNotificationRouter());
    await act(async () => {
      h.responseCb?.({ proposalId: 'p9', kind: 'executed' });
    });
    expect(h.push).toHaveBeenCalledWith('/proposals/p9');
  });

  it('a tap while running routes an allowlisted screen', async () => {
    renderHook(() => useNotificationRouter());
    await act(async () => {
      h.responseCb?.({ type: 'inbound_sms', screen: '/messages/m1' });
    });
    expect(h.push).toHaveBeenCalledWith('/messages/m1');
  });

  it('cold start: routes a launch notification with an unroutable payload to Home', async () => {
    h.lastData = { type: 'incoming_call', screen: '/not-allowed' };
    renderHook(() => useNotificationRouter());
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/'));
  });

  it('a foreground notification refreshes without navigating', async () => {
    const onForeground = vi.fn();
    renderHook(() => useNotificationRouter(onForeground));
    await act(async () => {
      h.foregroundCb?.();
    });
    expect(onForeground).toHaveBeenCalledTimes(1);
    expect(h.push).not.toHaveBeenCalled();
  });

  it('refreshes on every foreground push, not just the first', async () => {
    const onForeground = vi.fn();
    renderHook(() => useNotificationRouter(onForeground));
    await act(async () => {
      h.foregroundCb?.();
      h.foregroundCb?.();
    });
    expect(onForeground).toHaveBeenCalledTimes(2);
    expect(h.push).not.toHaveBeenCalled();
  });

  it('tolerates a foreground push when no onForeground callback is provided', async () => {
    renderHook(() => useNotificationRouter());
    await act(async () => {
      h.foregroundCb?.();
    });
    expect(h.push).not.toHaveBeenCalled();
  });

  it('removes its listeners on unmount', () => {
    const { unmount } = renderHook(() => useNotificationRouter());
    unmount();
    expect(h.responseRemove).toHaveBeenCalledTimes(1);
    expect(h.foregroundRemove).toHaveBeenCalledTimes(1);
  });
});

describe('emergency banner wiring (U4/B7)', () => {
  it('a foreground escalation/emergency raises the banner store; others do not', async () => {
    const { __resetEmergencyForTests, currentEmergency } = await import('./emergencyBanner');
    __resetEmergencyForTests();
    renderHook(() => useNotificationRouter());
    (h.foregroundCb as unknown as (d: unknown) => void)({ type: 'emergency', screen: '/approvals' });
    expect(currentEmergency()?.data.type).toBe('emergency');
    __resetEmergencyForTests();
    (h.foregroundCb as unknown as (d: unknown) => void)({ type: 'payment_received' });
    expect(currentEmergency()).toBeNull();
    __resetEmergencyForTests();
  });
});
