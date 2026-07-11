/**
 * ARCH-30 — fetchWithAuthRetry unit tests.
 *
 * This is the shared 401/403 helper extracted so useDispatchBoardStream,
 * useEscalationStream, useVoiceSession, and useActiveSessions stop
 * hand-rolling four divergent auth-failure behaviors. Locks in the
 * contract: no token → abort (never send unauthenticated); a single
 * 401/403 → retry once with a force-refreshed token; still rejected →
 * route through the shared `handleAuthFailure()` exit (mirrors
 * `lib/apiClient.ts` / `utils/api-fetch.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSignOutHandler, setSignOutHandler } from './apiClient';
import { fetchWithAuthRetry, isAuthRejectedStatus } from './streamAuth';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSignOutHandler();
});

describe('isAuthRejectedStatus', () => {
  it('treats 401 and 403 as auth-rejected, nothing else', () => {
    expect(isAuthRejectedStatus(401)).toBe(true);
    expect(isAuthRejectedStatus(403)).toBe(true);
    expect(isAuthRejectedStatus(200)).toBe(false);
    expect(isAuthRejectedStatus(500)).toBe(false);
  });
});

describe('fetchWithAuthRetry', () => {
  it('attaches a Bearer token from getToken() and returns a 2xx response as-is', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const getToken = vi.fn(async () => 'tok-1');

    const res = await fetchWithAuthRetry(getToken, '/api/escalations/events');

    expect(res.status).toBe(200);
    expect(getToken).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('throws an AbortError instead of sending a request when no token is available', async () => {
    const getToken = vi.fn(async () => null);

    await expect(fetchWithAuthRetry(getToken, '/api/escalations/events')).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on a single 401, retries once with a force-refreshed token and returns the success', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const getToken = vi.fn(async (opts?: { skipCache?: boolean }) =>
      opts?.skipCache ? 'tok-fresh' : 'tok-stale',
    );

    const res = await fetchWithAuthRetry(getToken, '/api/escalations/events');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenNthCalledWith(2, { skipCache: true });
    const retryHeaders = fetchMock.mock.calls[1][1].headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer tok-fresh');
  });

  it('same retry-then-success path applies to a 403', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const getToken = vi.fn(async (opts?: { skipCache?: boolean }) =>
      opts?.skipCache ? 'tok-fresh' : 'tok-stale',
    );

    const res = await fetchWithAuthRetry(getToken, '/api/escalations/events');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still-401 after the refreshed retry calls the shared handleAuthFailure() exit', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const getToken = vi.fn(async () => 'tok-stale');
    const signOut = vi.fn(async () => undefined);
    setSignOutHandler(signOut);

    const res = await fetchWithAuthRetry(getToken, '/api/escalations/events');

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a refresh that itself returns no token also triggers handleAuthFailure()', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const getToken = vi.fn(async (opts?: { skipCache?: boolean }) =>
      opts?.skipCache ? null : 'tok-stale',
    );
    const signOut = vi.fn(async () => undefined);
    setSignOutHandler(signOut);

    const res = await fetchWithAuthRetry(getToken, '/api/escalations/events');

    expect(res.status).toBe(403);
    // Only the first attempt hits fetch — no retry request without a token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
