// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __emitAppState } from '../../test/stubs/react-native';
import { __emitNetInfoForTests, __resetConnectivityForTests } from '../lib/connectivity';

const h = vi.hoisted(() => ({
  flushQueue: vi.fn(),
  showToast: vi.fn(),
  refresh: vi.fn(),
  queue: {
    restore: vi.fn(),
    depth: vi.fn(),
    reactivateAuthParked: vi.fn(),
  },
}));

vi.mock('@clerk/clerk-expo', () => ({
  useAuth: () => ({ getToken: vi.fn(async () => 'jwt'), isSignedIn: true }),
}));
vi.mock('../components/Toast', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../lib/env', () => ({ API_BASE_URL: 'https://api.test' }));
// expo-crypto has no vitest alias; the flush hook only needs the uploader seam.
vi.mock('../voice/nativeVoiceDeps', () => ({
  uploadFile: vi.fn(),
  makeIdempotencyKey: () => 'key',
}));
vi.mock('./flush', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./flush')>()),
  flushQueue: h.flushQueue,
}));
vi.mock('./queueInstance', () => ({ getOfflineQueue: () => h.queue }));

// eslint-disable-next-line import/first
import { useOfflineFlush, requestOfflineFlush } from './useOfflineFlush';

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetConnectivityForTests();
  h.queue.restore.mockResolvedValue([]);
  h.queue.depth.mockReturnValue(1);
  h.queue.reactivateAuthParked.mockResolvedValue(0);
  h.flushQueue.mockResolvedValue({ flushed: 1, dropped: 0 });
});

afterEach(() => {
  cleanup();
  __resetConnectivityForTests();
});

describe('useOfflineFlush', () => {
  it('restores and flushes on mount, then refreshes the inbox', async () => {
    renderHook(() => useOfflineFlush({ enabled: true, onInboxRefresh: h.refresh }));
    await settle();

    expect(h.queue.restore).toHaveBeenCalled();
    expect(h.flushQueue).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('skips the flush when the queue is empty', async () => {
    h.queue.depth.mockReturnValue(0);
    renderHook(() => useOfflineFlush({ enabled: true }));
    await settle();

    expect(h.flushQueue).not.toHaveBeenCalled();
  });

  it('flushes on the reconnect edge', async () => {
    renderHook(() => useOfflineFlush({ enabled: true }));
    await settle();
    h.flushQueue.mockClear();

    await act(async () => {
      __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
      __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    });
    await settle();

    expect(h.flushQueue).toHaveBeenCalledTimes(1);
  });

  it('flushes on app foreground and on manual retry', async () => {
    renderHook(() => useOfflineFlush({ enabled: true }));
    await settle();
    h.flushQueue.mockClear();

    await act(async () => {
      __emitAppState('active');
    });
    await settle();
    expect(h.flushQueue).toHaveBeenCalledTimes(1);

    await act(async () => {
      requestOfflineFlush();
    });
    await settle();
    expect(h.flushQueue).toHaveBeenCalledTimes(2);
  });

  it('surfaces the drop notice as a toast', async () => {
    h.flushQueue.mockImplementation(async (_queue: unknown, deps: { onItemDropped?: (i: unknown) => void }) => {
      deps.onItemDropped?.({ id: 'approval-p1', kind: 'approval', payload: { proposalId: 'p1' } });
      return { flushed: 0, dropped: 1 };
    });
    renderHook(() => useOfflineFlush({ enabled: true, onInboxRefresh: h.refresh }));
    await settle();

    expect(h.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Already handled' }),
    );
    expect(h.refresh).toHaveBeenCalledTimes(1); // dropped items also re-fetch the inbox
  });

  it('does nothing while disabled', async () => {
    renderHook(() => useOfflineFlush({ enabled: false }));
    await settle();

    expect(h.flushQueue).not.toHaveBeenCalled();
  });
});
