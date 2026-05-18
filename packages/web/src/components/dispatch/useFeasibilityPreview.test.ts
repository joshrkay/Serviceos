import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFeasibilityPreview, FeasibilityPreviewInput } from './useFeasibilityPreview';

describe('useFeasibilityPreview', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const baseInput: FeasibilityPreviewInput = {
    appointmentId: 'a-1',
    proposedTechnicianId: 'tech-1',
    proposedScheduledStart: '2026-05-17T10:00:00Z',
    proposedScheduledEnd: '2026-05-17T11:00:00Z',
  };

  it('does not fire fetch until the debounce window elapses', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ feasible: true, blocking: [], warnings: [], info: [], travelTime: null }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    const { rerender } = renderHook(({ input }) => useFeasibilityPreview(input), {
      initialProps: { input: baseInput },
    });
    rerender({ input: { ...baseInput, proposedScheduledStart: '2026-05-17T10:01:00Z' } });
    rerender({ input: { ...baseInput, proposedScheduledStart: '2026-05-17T10:02:00Z' } });
    act(() => { vi.advanceTimersByTime(149); });
    expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(2); });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  });

  it('exposes the latest feasibility result', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        feasible: false,
        blocking: [{ check: 'overlap', severity: 'blocking', message: 'x' }],
        warnings: [], info: [], travelTime: null,
      }),
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useFeasibilityPreview(baseInput));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(result.current.preview?.feasible).toBe(false);
  });

  it('returns null preview while input is null (idle)', () => {
    const { result } = renderHook(() => useFeasibilityPreview(null));
    expect(result.current.preview).toBeNull();
  });
});
