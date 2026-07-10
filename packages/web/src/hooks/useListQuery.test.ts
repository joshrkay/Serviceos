/**
 * useListQuery tests — including P0-030 auth-header injection coverage.
 *
 * Test names use the prefixes the dispatcher's verification gate filters on:
 * "useListQuery", "Authorization", "Bearer", "P0-030".
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Clerk mock — overridable per-test via clerkState ─────────────────────────
const clerkState = {
  token: 'tok-default' as string | null,
  freshToken: 'tok-fresh' as string | null,
  // Loose typing: vi.Mock for ergonomic .toHaveBeenCalledWith assertions while
  // letting tests swap in implementations that return null for the no-token
  // case.
  getToken: vi.fn() as ReturnType<typeof vi.fn>,
};

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: clerkState.getToken }),
}));

import { useListQuery } from './useListQuery';

beforeEach(() => {
  vi.restoreAllMocks();
  clerkState.token = 'tok-default';
  clerkState.freshToken = 'tok-fresh';
  clerkState.getToken = vi.fn(async (opts?: { template?: string; skipCache?: boolean }) => {
    return opts?.skipCache ? clerkState.freshToken : clerkState.token;
  }) as unknown as ReturnType<typeof vi.fn>;
});

function getAuthHeader(call: Parameters<typeof fetch>): string | null {
  const init = call[1] as RequestInit | undefined;
  if (!init) return null;
  const headers = init.headers;
  if (headers instanceof Headers) return headers.get('Authorization');
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => k.toLowerCase() === 'authorization');
    return found ? found[1] : null;
  }
  if (headers && typeof headers === 'object') {
    const obj = headers as Record<string, string>;
    return obj['Authorization'] ?? obj['authorization'] ?? null;
  }
  return null;
}

describe('useListQuery — basic behavior', () => {
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

  it('does not fetch when disabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: '1' }], total: 1 }),
    } as Response);

    const { result } = renderHook(() => useListQuery('/api/items', { enabled: false }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
    expect(result.current.total).toBe(0);
  });
});

describe('P0-030 useListQuery — Authorization Bearer header', () => {
  it('happy path: every request includes Bearer token from Clerk', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);

    renderHook(() => useListQuery('/api/items'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    expect(clerkState.getToken).toHaveBeenCalled();
    expect(getAuthHeader(fetchSpy.mock.calls[0]!)).toBe('Bearer tok-default');
  });

  it('no token: cancels the request, fetch is NOT called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    clerkState.getToken = vi.fn(async () => null) as unknown as ReturnType<typeof vi.fn>;

    const { result } = renderHook(() => useListQuery('/api/items'));

    // The hook swallows AbortError and clears error; it should not fire fetch.
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchSpy).not.toHaveBeenCalled();
    // AbortError is treated as a non-error, so error stays null.
    expect(result.current.error).toBeNull();
  });

  it('401 response: retries with skipCache token and recovers', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'r' }], total: 1 }),
      } as Response);

    const { result } = renderHook(() => useListQuery('/api/items'));

    await waitFor(() => expect(result.current.data).toEqual([{ id: 'r' }]));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(clerkState.getToken).toHaveBeenCalledWith({
      template: 'serviceos',
      skipCache: true,
    });
    expect(getAuthHeader(fetchSpy.mock.calls[0]!)).toBe('Bearer tok-default');
    expect(getAuthHeader(fetchSpy.mock.calls[1]!)).toBe('Bearer tok-fresh');
  });

  it('persistent 401: redirects to /login', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        get pathname() {
          return '/jobs';
        },
        set href(value: string) {
          hrefSetter(value);
        },
      },
    });

    renderHook(() => useListQuery('/api/items'));
    await waitFor(() => expect(hrefSetter).toHaveBeenCalled());
    expect(hrefSetter).toHaveBeenCalledWith(
      '/login?redirect=' + encodeURIComponent('/jobs')
    );
  });

  it('public route: does NOT include Authorization header for /api/public/*', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);

    renderHook(() => useListQuery('/api/public/estimates'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    expect(clerkState.getToken).not.toHaveBeenCalled();
    expect(getAuthHeader(fetchSpy.mock.calls[0]!)).toBeNull();
  });

  it('public estimate-approval prefix /public/ is treated as public', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);

    // /public/ paths don't start with /api/ so apiClient never injects auth.
    renderHook(() => useListQuery('/public/estimates'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    expect(clerkState.getToken).not.toHaveBeenCalled();
    expect(getAuthHeader(fetchSpy.mock.calls[0]!)).toBeNull();
  });
});

describe('useListQuery — live polling (Epic 12.2)', () => {
  it('re-fetches on the refetchInterval, and not at all without one', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: [], total: 0 }),
      } as Response);

      // No interval → exactly one fetch on mount, none after time passes.
      renderHook(() => useListQuery('/api/items'));
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fetchSpy.mockClear();

      // With an interval → an extra fetch each period.
      renderHook(() => useListQuery('/api/items', { refetchInterval: 1_000 }));
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps isLoading false and preserves rows during interval / explicit refetch (no flicker)', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const gates: Array<() => void> = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        call += 1;
        const n = call;
        if (n > 1) {
          await new Promise<void>((resolve) => {
            gates.push(resolve);
          });
        }
        return {
          ok: true,
          json: async () => ({ data: [{ id: String(n) }], total: 1 }),
        } as Response;
      });

      const { result } = renderHook(() =>
        useListQuery<{ id: string }>('/api/items', { refetchInterval: 1_000 })
      );

      await vi.waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.data).toEqual([{ id: '1' }]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await vi.waitFor(() => expect(gates.length).toBe(1));
      // Mid-poll: last-good rows stay mounted and isLoading stays false.
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toEqual([{ id: '1' }]);

      await act(async () => {
        gates.shift()?.();
      });
      await vi.waitFor(() => expect(result.current.data).toEqual([{ id: '2' }]));
      expect(result.current.isLoading).toBe(false);

      act(() => {
        result.current.refetch();
      });
      await vi.waitFor(() => expect(gates.length).toBe(1));
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toEqual([{ id: '2' }]);

      await act(async () => {
        gates.shift()?.();
      });
      await vi.waitFor(() => expect(result.current.data).toEqual([{ id: '3' }]));
      expect(result.current.isLoading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves last-good rows when a background refetch fails', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'ok' }], total: 1 }),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const { result } = renderHook(() => useListQuery<{ id: string }>('/api/items'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ id: 'ok' }]);

    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual([{ id: 'ok' }]);
    expect(result.current.error).toBeNull();
  });
});
