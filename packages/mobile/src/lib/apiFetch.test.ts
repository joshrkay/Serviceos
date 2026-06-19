import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiFetch, type TokenGetter } from './apiFetch';

const BASE = 'https://api.example.test';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeClient(over: { getToken?: TokenGetter; onUnauthenticated?: () => void } = {}) {
  return createApiFetch({
    baseUrl: BASE,
    getToken: over.getToken ?? (async () => 'tok'),
    onUnauthenticated: over.onUnauthenticated,
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
});
