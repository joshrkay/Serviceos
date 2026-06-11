import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOnboardingStatus } from './useOnboardingStatus';

describe('useOnboardingStatus', () => {
  beforeEach(() => {
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
});
