import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { useDispatchBoard } from './useDispatchBoard';

function boardResponse(marker: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      date: marker,
      unassignedAppointments: [],
      technicianLanes: [],
      summary: { unassigned: 0, scheduled: 0, inProgress: 0, completed: 0, canceled: 0 },
    }),
  } as Response;
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe('useDispatchBoard', () => {
  it('loads the board for the selected date on mount', async () => {
    apiFetch.mockResolvedValue(boardResponse('2026-03-14'));
    const { result } = renderHook(() => useDispatchBoard(new Date('2026-03-14T12:00:00Z')));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.date).toBe('2026-03-14');
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('date=2026-03-14'));
  });

  it('ignores a stale response that resolves after a newer one (fast date paging)', async () => {
    // First render's request is slow; a re-render with a new date fires a
    // second, faster request. The slow (older) response must not win.
    let resolveSlow: (r: Response) => void = () => {};
    const slow = new Promise<Response>((res) => {
      resolveSlow = res;
    });
    apiFetch.mockReturnValueOnce(slow);
    apiFetch.mockResolvedValueOnce(boardResponse('2026-03-15'));

    const { result, rerender } = renderHook(({ d }) => useDispatchBoard(d), {
      initialProps: { d: new Date('2026-03-14T12:00:00Z') },
    });

    rerender({ d: new Date('2026-03-15T12:00:00Z') });
    await waitFor(() => expect(result.current.data?.date).toBe('2026-03-15'));

    // Now the older request finally resolves — it should be discarded.
    await act(async () => {
      resolveSlow(boardResponse('2026-03-14'));
      await slow;
    });
    expect(result.current.data?.date).toBe('2026-03-15');
  });

  it('keeps the board mounted (isLoading stays false, data preserved) during a background refetch', async () => {
    apiFetch.mockResolvedValueOnce(boardResponse('2026-03-14'));
    const { result } = renderHook(() => useDispatchBoard(new Date('2026-03-14T12:00:00Z')));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let resolveRefresh: (r: Response) => void = () => {};
    apiFetch.mockReturnValueOnce(
      new Promise<Response>((res) => {
        resolveRefresh = res;
      }),
    );

    act(() => {
      result.current.refetch();
    });
    // Mid-refresh: the previous board is still shown and no loading flash.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data?.date).toBe('2026-03-14');

    await act(async () => {
      resolveRefresh(boardResponse('2026-03-14b'));
    });
    await waitFor(() => expect(result.current.data?.date).toBe('2026-03-14b'));
  });

  it('preserves the last-good board when a background refetch fails', async () => {
    apiFetch.mockResolvedValueOnce(boardResponse('2026-03-14'));
    const { result } = renderHook(() => useDispatchBoard(new Date('2026-03-14T12:00:00Z')));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    apiFetch.mockRejectedValueOnce(new Error('network blip'));
    await act(async () => {
      result.current.refetch();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data?.date).toBe('2026-03-14');
  });
});
