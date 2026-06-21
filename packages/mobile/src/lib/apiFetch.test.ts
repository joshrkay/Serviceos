import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiFetch, DEFAULT_TIMEOUT_MS, type TokenGetter } from './apiFetch';

const BASE = 'https://api.example.test';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeClient(
  over: { getToken?: TokenGetter; onUnauthenticated?: () => void; timeoutMs?: number } = {},
) {
  return createApiFetch({
    baseUrl: BASE,
    getToken: over.getToken ?? (async () => 'tok'),
    onUnauthenticated: over.onUnauthenticated,
    timeoutMs: over.timeoutMs,
  });
}

function lastCall(): [string, RequestInit] {
  const calls = fetchMock.mock.calls;
  return calls[calls.length - 1] as [string, RequestInit];
}

function headers(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('createApiFetch', () => {
  it('resolves /api/ paths against baseUrl and attaches the Bearer token', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const client = makeClient({ getToken: async () => 'tok-1' });

    await client('/api/me');

    const [url, init] = lastCall();
    expect(url).toBe(`${BASE}/api/me`);
    expect(headers(init).Authorization).toBe('Bearer tok-1');
  });

  it('never attaches Authorization on public paths, but still sets JSON Content-Type', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const client = makeClient({ getToken: async () => 'tok' });

    await client('/api/public/estimate/abc', { method: 'POST', body: '{}' });

    const [, init] = lastCall();
    expect(headers(init).Authorization).toBeUndefined();
    expect(headers(init)['Content-Type']).toBe('application/json');
  });

  it('cancels with an AbortError (no request) when the token is null', async () => {
    const client = makeClient({ getToken: async () => null });

    await expect(client('/api/me')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries once with a force-refreshed token on a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const getToken = vi
      .fn()
      .mockResolvedValueOnce('stale')
      .mockResolvedValueOnce('fresh');

    const res = await makeClient({ getToken })('/api/me');

    expect(res.status).toBe(200);
    expect(getToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(headers(lastCall()[1]).Authorization).toBe('Bearer fresh');
  });

  it('invokes onUnauthenticated and throws when the retry is still 401', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const onUnauthenticated = vi.fn();

    await expect(
      makeClient({ getToken: async () => 'tok', onUnauthenticated })('/api/me'),
    ).rejects.toThrow(/Unauthorized/);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('attaches a best-effort token for non-/api paths but never retries on 401', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const onUnauthenticated = vi.fn();

    const res = await makeClient({ getToken: async () => 'tok', onUnauthenticated })('/health');

    expect(res.status).toBe(401);
    expect(onUnauthenticated).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headers(lastCall()[1]).Authorization).toBe('Bearer tok');
  });

  it('passes an AbortSignal to fetch so a request can be timed out', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await makeClient()('/api/me');

    expect(lastCall()[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects with a TimeoutError when the request outlives the timeout', async () => {
    vi.useFakeTimers();
    try {
      // A fetch that hangs until its abort signal fires — the real socket-hang case.
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );

      const pending = makeClient({ timeoutMs: 50 })('/api/me');
      const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not set a timeout when timeoutMs is 0', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await makeClient({ timeoutMs: 0 })('/api/me');

    expect(lastCall()[1].signal).toBeUndefined();
  });

  it('returns the non-2xx response with its body intact for the caller to decode', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'No such job' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await makeClient()('/api/jobs/missing');

    expect(res.status).toBe(404);
    // The body must survive so callers can `decodeError(res)` it.
    await expect(res.json()).resolves.toEqual({ error: 'NOT_FOUND', message: 'No such job' });
  });

  it('defaults the timeout to DEFAULT_TIMEOUT_MS', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
