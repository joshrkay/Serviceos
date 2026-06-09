/**
 * apiFetch behavior contract.
 *
 * Pre-fix, `apiFetch` opportunistically attached a Bearer if it had a
 * token and otherwise sent the request anyway with no Authorization —
 * meaning every expired-token call became a 401 the caller had to handle
 * on its own. This suite locks in the upgraded behavior, which mirrors
 * `useApiClient`:
 *
 *   1. Public, view-token-gated paths never receive Authorization.
 *   2. Authenticated `/api/` paths require a token; missing token →
 *      AbortError (we MUST NOT send unauthenticated to a protected route).
 *   3. On a 401 from an authenticated path, retry ONCE with a
 *      forcibly-refreshed token before bouncing to /login.
 *   4. Non-`/api/` URLs (assets, third-party hosts) get a best-effort
 *      Bearer if we happen to have one, but no retry / no redirect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, clearTokenGetter, setTokenGetter } from './api-fetch';

const TOKEN = 'tok-fresh';
const REFRESHED = 'tok-refreshed';

let fetchMock: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

function installLocation() {
  // jsdom locks window.location.href, so spy via assign + replace
  // through a mock object that captures `.href = ...` assignments.
  const href = { value: '' };
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...originalLocation,
      pathname: '/jobs',
      search: '?status=open',
      get href() { return href.value; },
      set href(v: string) { href.value = v; },
    },
  });
  return href;
}

function restoreLocation() {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearTokenGetter();
  restoreLocation();
});

describe('apiFetch — public API paths', () => {
  it('does not attach Authorization for /api/public/* paths', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setTokenGetter(async () => TOKEN);

    await apiFetch('/api/public/estimate-approval/abc');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('does not attach Authorization for /api/public-payments/* paths', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setTokenGetter(async () => TOKEN);

    await apiFetch('/api/public-payments/intent', { method: 'POST', body: '{}' });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    // Content-Type still inferred for string bodies on public paths.
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('does not 401-retry public paths (no redirect either)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const href = installLocation();
    setTokenGetter(async () => TOKEN);

    const res = await apiFetch('/api/public/estimate-approval/abc');

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(href.value).toBe('');
  });
});

describe('apiFetch — authenticated /api/ paths', () => {
  it('attaches Bearer when a token is available', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setTokenGetter(async () => TOKEN);

    await apiFetch('/api/jobs');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('falls through to passthrough fetch when no getter is wired (test / pre-bridge boot)', async () => {
    // No setTokenGetter — simulates the pre-mount-bridge window and the
    // 80+ existing component tests that mock fetch without setting up
    // Clerk. Sending the request unauthenticated is fine here because the
    // bridge is always mounted in production; abandoning would break
    // every test that doesn't wire Clerk.
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const res = await apiFetch('/api/jobs');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws AbortError when getToken returns null (sign-out transition)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setTokenGetter(async () => null);

    let err: unknown;
    try {
      await apiFetch('/api/jobs');
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe('AbortError');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a 401 once with a force-refreshed token', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const getToken = vi.fn(async (opts?: { forceRefresh?: boolean }) =>
      opts?.forceRefresh ? REFRESHED : TOKEN,
    );
    setTokenGetter(getToken);

    const res = await apiFetch('/api/jobs');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call uses the refreshed token.
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${REFRESHED}`);
    // getToken called twice — once initial, once with forceRefresh.
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken.mock.calls[1][0]).toEqual({ forceRefresh: true });
  });

  it('redirects to /login when the retry also returns 401', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const href = installLocation();
    setTokenGetter(async () => TOKEN);

    let err: unknown;
    try {
      await apiFetch('/api/jobs');
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/redirecting to login/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(href.value).toBe('/login?redirect=' + encodeURIComponent('/jobs?status=open'));
  });

  it('redirects to /login if the refresh getter throws (still bounces, no infinite retry)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const href = installLocation();
    const getToken = vi.fn(async (opts?: { forceRefresh?: boolean }) => {
      if (opts?.forceRefresh) throw new Error('clerk down');
      return TOKEN;
    });
    setTokenGetter(getToken);

    await expect(apiFetch('/api/jobs')).rejects.toThrow(/redirecting to login/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry — getter threw
    expect(href.value).toMatch(/^\/login\?redirect=/);
  });

  it('still inserts default Content-Type for string bodies', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setTokenGetter(async () => TOKEN);

    await apiFetch('/api/jobs', { method: 'POST', body: JSON.stringify({ x: 1 }) });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('respects a caller-supplied Content-Type', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setTokenGetter(async () => TOKEN);

    await apiFetch('/api/jobs', {
      method: 'POST',
      body: 'hello',
      headers: { 'Content-Type': 'text/plain' },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
  });
});

describe('apiFetch — non-/api paths', () => {
  it('opportunistically attaches Bearer if a token is available', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    setTokenGetter(async () => TOKEN);

    await apiFetch('/assets/icon.png');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('proceeds without auth when no token getter is configured (no AbortError)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const res = await apiFetch('/assets/icon.png');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('does not 401-retry non-/api paths', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const href = installLocation();
    setTokenGetter(async () => TOKEN);

    const res = await apiFetch('https://cdn.example.com/x');

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(href.value).toBe('');
  });
});

describe('setTokenGetter — backwards-compatible call shape', () => {
  it('accepts the legacy zero-arg getter form and treats forceRefresh as a no-op', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const legacy = vi.fn<[], Promise<string | null>>(async () => TOKEN);
    setTokenGetter(legacy);

    const res = await apiFetch('/api/jobs');
    expect(res.status).toBe(200);
    // Legacy getter is invoked with no args both times.
    expect(legacy.mock.calls[0]).toEqual([]);
    expect(legacy.mock.calls[1]).toEqual([]);
  });
});
