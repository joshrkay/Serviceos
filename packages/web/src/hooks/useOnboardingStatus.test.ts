import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useOnboardingStatus,
  invalidateOnboardingStatusCache,
  _resetOnboardingStatusCacheForTests,
} from './useOnboardingStatus';

describe('useOnboardingStatus', () => {
  beforeEach(() => {
    _resetOnboardingStatusCacheForTests();
    vi.restoreAllMocks();
  });

  it('fetches status on mount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        steps: [
          { id: 'signup', status: 'done' },
          { id: 'identity', status: 'current' },
          { id: 'pack', status: 'pending' },
          { id: 'phone', status: 'pending' },
          { id: 'billing', status: 'pending' },
          { id: 'test_call', status: 'pending' },
        ],
        currentStep: 'identity',
        isComplete: false,
        voiceAgentLive: false,
      }),
    } as Response);

    const { result } = renderHook(() => useOnboardingStatus(0));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.currentStep).toBe('identity');
    expect(result.current.data?.isComplete).toBe(false);
  });

  it('surfaces HTTP errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    const { result } = renderHook(() => useOnboardingStatus(0));
    await waitFor(() => expect(result.current.error).toBe('HTTP 503'));
    expect(result.current.data).toBeNull();
  });

  it('handles network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useOnboardingStatus(0));
    await waitFor(() => expect(result.current.error).toBe('boom'));
  });

  it('skips fetch when enabled is false', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { result } = renderHook(() => useOnboardingStatus(30_000, false));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('after the cache is invalidated', () => {
    afterEach(() => vi.useRealTimers());

    const at = (currentStep: string) => ({ currentStep, isComplete: false, voiceAgentLive: false, steps: [] });

    it('does not let a slow earlier response put the stale status back for the next poll to replay', async () => {
      vi.useFakeTimers();
      const pending: Array<(body: unknown) => void> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            pending.push((body) => resolve({ ok: true, json: () => Promise.resolve(body) } as Response));
          }),
      );
      const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

      // A poll is on its way (mount) and has not been answered when the owner acts.
      const { result } = renderHook(() => useOnboardingStatus(1000));
      await flush();
      expect(pending).toHaveLength(1);

      // The action: drop the cache and ask for real. The fresh answer comes back first, then the slow stale one.
      invalidateOnboardingStatusCache();
      act(() => void result.current.refetch());
      await flush();
      expect(pending).toHaveLength(2);
      pending[1](at('phone'));
      await flush();
      expect(result.current.data?.currentStep).toBe('phone');
      pending[0](at('billing'));
      await flush();

      // The next tick is inside the cache window: it must replay the fresh answer, with no request at all.
      await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
      expect(result.current.data?.currentStep).toBe('phone');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('does not let a stale completion clear the slot of the request that replaced it', async () => {
      const pending: Array<(body: unknown) => void> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            pending.push((body) => resolve({ ok: true, json: () => Promise.resolve(body) } as Response));
          }),
      );
      const first = renderHook(() => useOnboardingStatus(0));
      await waitFor(() => expect(pending).toHaveLength(1));
      invalidateOnboardingStatusCache();
      const second = renderHook(() => useOnboardingStatus(0));
      await waitFor(() => expect(pending).toHaveLength(2));

      // The stale request finishes while the new one is still out: a third consumer joins the new one.
      pending[0](at('billing'));
      await act(() => Promise.resolve());
      const third = renderHook(() => useOnboardingStatus(0));
      await act(() => Promise.resolve());
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      pending[1](at('phone'));
      await act(() => Promise.resolve());
      await waitFor(() => expect(third.result.current.data?.currentStep).toBe('phone'));
      expect(second.result.current.data?.currentStep).toBe('phone');
    });
  });
});
