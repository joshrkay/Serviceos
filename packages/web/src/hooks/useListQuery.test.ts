import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useListQuery } from './useListQuery';

describe('useListQuery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches list data on mount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: '1' }], total: 1 }),
    } as Response);

    const { result } = renderHook(() => useListQuery('/api/items'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ id: '1' }]);
    expect(result.current.total).toBe(1);
  });

  it('handles fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);

    const { result } = renderHook(() => useListQuery('/api/items'));

    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
  });

  it('handles network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline'));

    const { result } = renderHook(() => useListQuery('/api/items'));

    await waitFor(() => expect(result.current.error).toBe('Offline'));
  });

  it('setPage triggers re-fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);

    const { result } = renderHook(() => useListQuery('/api/items'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.setPage(2));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(result.current.page).toBe(2);
  });

  it('setSearch triggers re-fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);

    const { result } = renderHook(() => useListQuery('/api/items'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.setSearch('test'));
    await waitFor(() => {
      const url = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0] as string;
      expect(url).toContain('search=test');
    });
  });

  it('setFilters triggers re-fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);

    const { result } = renderHook(() => useListQuery('/api/items'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.setFilters({ status: 'open' }));
    await waitFor(() => {
      const url = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0] as string;
      expect(url).toContain('status=open');
    });
  });

  it('uses initial options', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);

    renderHook(() => useListQuery('/api/items', { page: 3, pageSize: 10, search: 'hello' }));
    await waitFor(() => {
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('page=3');
      expect(url).toContain('pageSize=10');
      expect(url).toContain('search=hello');
    });
  });

  it('handles array response format', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{ id: '1' }, { id: '2' }],
    } as Response);

    const { result } = renderHook(() => useListQuery('/api/items'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ id: '1' }, { id: '2' }]);
    expect(result.current.total).toBe(2);
  });
});
