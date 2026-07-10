import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useDetailQuery } from './useDetailQuery';

// P0-030 note: useDetailQuery now reads the Clerk JWT via useAuth(). The
// global test-setup.ts installs a permissive Clerk mock — so this file can
// keep validating its existing data-fetching contract unchanged.

describe('useDetailQuery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches data on mount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: '1', name: 'Test' }),
    } as Response);

    const { result } = renderHook(() => useDetailQuery('/api/items', '1'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual({ id: '1', name: 'Test' });
    expect(result.current.error).toBeNull();
  });

  it('handles fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    const { result } = renderHook(() => useDetailQuery('/api/items', '1'));

    await waitFor(() => expect(result.current.error).toBe('HTTP 404'));
    expect(result.current.data).toBeNull();
  });

  it('handles network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useDetailQuery('/api/items', '1'));

    await waitFor(() => expect(result.current.error).toBe('Network error'));
  });

  it('does not fetch when id is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { result } = renderHook(() => useDetailQuery('/api/items', null));

    expect(result.current.isLoading).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refetch re-fetches data without clearing the entity (no detail flicker)', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      return { ok: true, json: async () => ({ id: '1', count: callCount }) } as Response;
    });

    const { result } = renderHook(() => useDetailQuery('/api/items', '1'));
    await waitFor(() => expect(result.current.data).toEqual({ id: '1', count: 1 }));

    act(() => {
      result.current.refetch();
    });
    // Same-id refetch must keep last-good entity mounted and not flip isLoading.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual({ id: '1', count: 1 });
    await waitFor(() => expect(result.current.data).toEqual({ id: '1', count: 2 }));
    expect(result.current.isLoading).toBe(false);
  });

  it('clears data when the id changes so the prior entity never leaks', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const id = url.split('/').pop();
      return { ok: true, json: async () => ({ id, name: `Item ${id}` }) } as Response;
    });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useDetailQuery('/api/items', id),
      { initialProps: { id: '1' } }
    );
    await waitFor(() => expect(result.current.data).toEqual({ id: '1', name: 'Item 1' }));

    rerender({ id: '2' });
    // Cold id swap: prior entity cleared, loading true until the new one lands.
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ id: '2', name: 'Item 2' }));
  });

  it('preserves last-good entity when a background refetch fails', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: '1', name: 'ok' }),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const { result } = renderHook(() => useDetailQuery('/api/items', '1'));
    await waitFor(() => expect(result.current.data).toEqual({ id: '1', name: 'ok' }));

    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual({ id: '1', name: 'ok' });
    expect(result.current.error).toBeNull();
  });
});
