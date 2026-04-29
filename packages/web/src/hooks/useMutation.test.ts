/**
 * useMutation tests — including P0-030 auth-header injection coverage.
 *
 * Test names use the prefixes the dispatcher's verification gate filters on:
 * "useMutation", "Authorization", "Bearer", "P0-030".
 */
import { renderHook, act } from '@testing-library/react';
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

// Imports that depend on the mock must come AFTER vi.mock above.
import { useMutation } from './useMutation';

beforeEach(() => {
  vi.restoreAllMocks();
  clerkState.token = 'tok-default';
  clerkState.freshToken = 'tok-fresh';
  clerkState.getToken = vi.fn(async (opts?: { skipCache?: boolean }) => {
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

describe('useMutation — basic behavior', () => {
  it('starts with isLoading false and no error', () => {
    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('calls fetch with correct method, path, and JSON body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: '1' }),
    } as Response);

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await result.current.mutate({ name: 'Test' });
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/items');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ name: 'Test' }));
    const headers = init!.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('returns parsed response on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: '42', name: 'Created' }),
    } as Response);

    const { result } = renderHook(() => useMutation<{ name: string }, { id: string; name: string }>('POST', '/api/items'));
    let response: { id: string; name: string } | undefined;
    await act(async () => {
      response = await result.current.mutate({ name: 'Created' });
    });

    expect(response).toEqual({ id: '42', name: 'Created' });
    expect(result.current.error).toBeNull();
  });

  it('sets error and re-throws on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
    } as Response);

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await expect(result.current.mutate({})).rejects.toThrow('HTTP 422');
    });

    expect(result.current.error).toBe('HTTP 422');
  });

  it('sets error and re-throws on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await expect(result.current.mutate({})).rejects.toThrow('Network error');
    });

    expect(result.current.error).toBe('Network error');
  });

  it('resets isLoading to false after request completes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await result.current.mutate({});
    });

    expect(result.current.isLoading).toBe(false);
  });

  it('works with PUT method', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: '1' }),
    } as Response);

    const { result } = renderHook(() => useMutation('PUT', '/api/items/1'));
    await act(async () => {
      await result.current.mutate({ name: 'Updated' });
    });

    expect(fetchSpy).toHaveBeenCalledWith('/api/items/1', expect.objectContaining({ method: 'PUT' }));
  });
});

describe('P0-030 useMutation — Authorization Bearer header', () => {
  it('happy path: includes Bearer token from Clerk getToken on every request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: '1' }),
    } as Response);

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await result.current.mutate({ name: 'Test' });
    });

    expect(clerkState.getToken).toHaveBeenCalled();
    const auth = getAuthHeader(fetchSpy.mock.calls[0]!);
    expect(auth).toBe('Bearer tok-default');
  });

  it('Bearer token reflects the value returned by getToken on each call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: '1' }),
    } as Response);

    // First call returns one token, second call returns another — proves we
    // never cache across requests.
    let n = 0;
    clerkState.getToken = vi.fn(async () => `tok-${++n}`) as unknown as ReturnType<typeof vi.fn>;

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await result.current.mutate({});
    });
    await act(async () => {
      await result.current.mutate({});
    });

    expect(getAuthHeader(fetchSpy.mock.calls[0]!)).toBe('Bearer tok-1');
    expect(getAuthHeader(fetchSpy.mock.calls[1]!)).toBe('Bearer tok-2');
  });

  it('no token: cancels the request with AbortError, fetch is NOT called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    clerkState.getToken = vi.fn(async () => null) as unknown as ReturnType<typeof vi.fn>;

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await expect(result.current.mutate({})).rejects.toMatchObject({
        name: 'AbortError',
      });
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('401 response: retries once with skipCache token, returns retry result on success', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'ok' }) } as Response);

    const { result } = renderHook(() => useMutation<unknown, { id: string }>('POST', '/api/items'));
    let resp: { id: string } | undefined;
    await act(async () => {
      resp = await result.current.mutate({});
    });

    expect(resp).toEqual({ id: 'ok' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(clerkState.getToken).toHaveBeenCalledWith({ skipCache: true });
    // First call uses the cached token, second uses the fresh one.
    expect(getAuthHeader(fetchSpy.mock.calls[0]!)).toBe('Bearer tok-default');
    expect(getAuthHeader(fetchSpy.mock.calls[1]!)).toBe('Bearer tok-fresh');
  });

  it('persistent 401: redirects to /login with redirect query', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

    // jsdom's window.location is read-only for href; spy via Object.defineProperty.
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        get pathname() {
          return '/customers';
        },
        set href(value: string) {
          hrefSetter(value);
        },
      },
    });

    const { result } = renderHook(() => useMutation('POST', '/api/items'));
    await act(async () => {
      await expect(result.current.mutate({})).rejects.toThrow(/Unauthorized/);
    });

    expect(hrefSetter).toHaveBeenCalledWith(
      '/login?redirect=' + encodeURIComponent('/customers')
    );
  });

  it('public route: does NOT include Authorization header for /api/public-payments/*', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const { result } = renderHook(() =>
      useMutation('POST', '/api/public-payments/create-payment-intent')
    );
    await act(async () => {
      await result.current.mutate({});
    });

    expect(clerkState.getToken).not.toHaveBeenCalled();
    expect(getAuthHeader(fetchSpy.mock.calls[0]!)).toBeNull();
  });

  it('Gemini: Authorization header survives when callers pass a Headers instance', async () => {
    // Direct apiClient call with init.headers as a Headers instance
    // (the bug: spread {} on a Headers instance dropped all entries
    // and the Authorization injection then ran on an empty headers
    // object). Now the merge goes through `new Headers(...)` so all
    // three input shapes round-trip cleanly.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    const { useApiClient } = await import('../lib/apiClient');
    const { result } = renderHook(() => useApiClient());
    const headersInstance = new Headers({ 'X-Custom': 'preserved' });
    await act(async () => {
      await result.current('/api/items', {
        method: 'POST',
        body: JSON.stringify({ name: 'x' }),
        headers: headersInstance,
      });
    });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const sent = init.headers as Record<string, string>;
    // Headers ctor normalizes keys to lowercase on iteration; assert
    // case-insensitively.
    const customKey = Object.keys(sent).find((k) => k.toLowerCase() === 'x-custom');
    expect(customKey, 'caller-provided X-Custom must round-trip').toBeDefined();
    expect(sent[customKey!]).toBe('preserved');
    expect(sent['Authorization']).toBe('Bearer tok-default');
  });

  it('Gemini: Content-Type=application/json is set ONLY for string bodies', async () => {
    // For FormData / URLSearchParams / Blob / ArrayBuffer, fetch()
    // sets the right Content-Type itself (multipart boundary etc).
    // Forcing application/json there used to corrupt the request.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);

    const { useApiClient } = await import('../lib/apiClient');
    const { result } = renderHook(() => useApiClient());

    // String body -> Content-Type set
    await act(async () => {
      await result.current('/api/items', {
        method: 'POST',
        body: JSON.stringify({ a: 1 }),
      });
    });
    let init = fetchSpy.mock.calls[0]![1] as RequestInit;
    let sent = init.headers as Record<string, string>;
    expect(sent['Content-Type']).toBe('application/json');

    // FormData body -> Content-Type NOT set (let fetch infer)
    fetchSpy.mockClear();
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'foo.bin');
    await act(async () => {
      await result.current('/api/upload', { method: 'POST', body: fd });
    });
    init = fetchSpy.mock.calls[0]![1] as RequestInit;
    sent = init.headers as Record<string, string>;
    expect(sent['Content-Type']).toBeUndefined();

    // URLSearchParams body -> Content-Type NOT set
    fetchSpy.mockClear();
    await act(async () => {
      await result.current('/api/form', {
        method: 'POST',
        body: new URLSearchParams({ k: 'v' }),
      });
    });
    init = fetchSpy.mock.calls[0]![1] as RequestInit;
    sent = init.headers as Record<string, string>;
    expect(sent['Content-Type']).toBeUndefined();
  });
});
