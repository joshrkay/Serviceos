/**
 * ARCH-30 — useDispatchBoardStream 401/403 handling.
 *
 * Pre-fix, a 401/403 from the board SSE endpoint just `return`ed — the
 * live board went silently dead until the operator navigated away and
 * back. This pins the fixed behavior: the hook now goes through the
 * shared `fetchWithAuthRetry` helper (retry once with a force-refreshed
 * token, then the shared `handleAuthFailure()` exit on a persistent
 * rejection) AND keeps trying to reconnect afterward instead of giving up
 * for the component's lifetime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDispatchBoardStream } from './useDispatchBoardStream';
import { clearSignOutHandler, setSignOutHandler } from '../lib/apiClient';

const getTokenMock = vi.fn(async (opts?: { skipCache?: boolean }) =>
  opts?.skipCache ? 'tok-fresh' : 'tok-stale',
);

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: getTokenMock }),
}));

const fetchMock = vi.fn();

async function flushMicrotasks(times = 30) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('useDispatchBoardStream — ARCH-30 401/403 handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    getTokenMock.mockClear();
  });

  afterEach(() => {
    clearSignOutHandler();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a persistent 401 retries once with a refreshed token, then signs out via the shared helper', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const signOut = vi.fn(async () => undefined);
    setSignOutHandler(signOut);
    const onStale = vi.fn();

    const { unmount } = renderHook(() =>
      useDispatchBoardStream('2026-07-11', 'rev-1', onStale),
    );

    await flushMicrotasks();

    // Initial attempt + one force-refreshed retry, both 401.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getTokenMock).toHaveBeenNthCalledWith(2, { template: 'serviceos', skipCache: true });
    // The shared 401 helper routed the persistent rejection through
    // handleAuthFailure() instead of the hook hand-rolling its own exit.
    expect(signOut).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('does NOT silently give up after a 401/403 — it schedules a reconnect', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    setSignOutHandler(vi.fn(async () => undefined));
    const onStale = vi.fn();

    const { unmount } = renderHook(() =>
      useDispatchBoardStream('2026-07-11', 'rev-1', onStale),
    );

    await flushMicrotasks();
    const callsAfterFirstAttempt = fetchMock.mock.calls.length;
    expect(callsAfterFirstAttempt).toBeGreaterThan(0);

    // Advance past the reconnect backoff (starts at 1s) — the previous
    // behavior was a bare `return` here with no further fetch ever firing.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirstAttempt);

    unmount();
  });
});
