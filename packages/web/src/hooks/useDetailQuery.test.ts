import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useDetailQuery } from './useDetailQuery';

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

  it('refetch re-fetches data', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      return { ok: true, json: async () => ({ id: '1', count: callCount }) } as Response;
    });

    const { result } = renderHook(() => useDetailQuery('/api/items', '1'));
    await waitFor(() => expect(result.current.data).toEqual({ id: '1', count: 1 }));

    result.current.refetch();
    await waitFor(() => expect(result.current.data).toEqual({ id: '1', count: 2 }));
  });
});
