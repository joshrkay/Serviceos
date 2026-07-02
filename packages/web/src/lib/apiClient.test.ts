/**
 * Unit tests for redirectToLogin() — story P20-003.
 *
 * These tests focus on the URL construction performed by the (otherwise
 * private) redirectToLogin helper. We verify:
 *   (a) pathname + search is preserved and correctly encoded
 *   (b) a bare '/' path still works
 *   (c) being on a /login* path falls back to '/' (loop guard)
 *
 * The 401-retry logic itself (which is what *calls* redirectToLogin) is
 * tested in useListQuery.test.ts and is not re-tested here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Re-export redirectToLogin for testability by monkey-patching the module.
 * The function is not exported from apiClient.ts (intentionally), so we
 * test it indirectly by triggering a persistent-401 scenario via
 * useApiClient. However, for the focused URL-construction cases required
 * by P20-003, we test the observable side-effect: window.location.href.
 *
 * Strategy: import useApiClient, mock getToken + fetch to produce a
 * persistent 401, capture window.location.href via a setter spy, and
 * assert on the value set.
 */
import { renderHook } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { useApiClient } from './apiClient';

// ── Clerk mock ───────────────────────────────────────────────────────────────
const mockGetToken = vi.fn(async () => 'tok-test');

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  mockGetToken.mockImplementation(async () => 'tok-test');
});

/**
 * Helper: trigger a persistent 401 (initial + retry both return 401) and
 * capture what value was assigned to window.location.href.
 *
 * The caller is responsible for setting up window.location mock before
 * calling this.
 */
async function triggerRedirect(): Promise<string> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

  const hrefSetter = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      ...window.location,
      set href(v: string) {
        hrefSetter(v);
      },
    },
  });

  // We override per-test to set pathname / search; that override must happen
  // BEFORE we call triggerRedirect. The helper just captures the href.
  const { result } = renderHook(() => useApiClient());
  // Wait until the hook is initialised (non-null).
  await waitFor(() => expect(result.current).toBeDefined());
  // Fire the request — ignore any thrown error (the redirect throw is expected).
  await result.current('/api/items').catch(() => null);

  return hrefSetter.mock.calls[0]?.[0] ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Journey QA 2026-07-02 (bug 1) — Content-Type injection must be
 * case-insensitive. A caller passing lowercase 'content-type' previously got
 * BOTH keys; fetch merged them into "application/json, application/json" and
 * Express dropped the JSON body, so inbox batch approvals always 400'd.
 */
describe('useApiClient — single Content-Type on outgoing requests', () => {
  /** Fire a request through the hook and return the headers fetch received. */
  async function capturedHeaders(init: RequestInit): Promise<Record<string, string>> {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const { result } = renderHook(() => useApiClient());
    await waitFor(() => expect(result.current).toBeDefined());
    await result.current('/api/proposals/approve-batch', init);
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    return headers ?? {};
  }

  function contentTypeKeys(headers: Record<string, string>): string[] {
    return Object.keys(headers).filter((k) => k.toLowerCase() === 'content-type');
  }

  it('lowercase caller header: does NOT add a duplicate Content-Type', async () => {
    const headers = await capturedHeaders({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalIds: ['p-1'] }),
    });
    expect(contentTypeKeys(headers)).toEqual(['content-type']);
    expect(headers['content-type']).toBe('application/json');
  });

  it('canonical-case caller header: keeps exactly one Content-Type', async () => {
    const headers = await capturedHeaders({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalIds: ['p-1'] }),
    });
    expect(contentTypeKeys(headers)).toEqual(['Content-Type']);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('mixed-case caller header (CONTENT-TYPE) also suppresses injection', async () => {
    const headers = await capturedHeaders({
      method: 'POST',
      headers: { 'CONTENT-TYPE': 'application/json' },
      body: '{"a":1}',
    });
    expect(contentTypeKeys(headers)).toEqual(['CONTENT-TYPE']);
  });

  it('no caller header + string body: injects application/json once', async () => {
    const headers = await capturedHeaders({
      method: 'POST',
      body: '{"a":1}',
    });
    expect(contentTypeKeys(headers)).toEqual(['Content-Type']);
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('P20-003 redirectToLogin — URL construction', () => {
  it(
    'P20-003 (a): preserves pathname + query string in the redirect param',
    async () => {
      // Set up location with a pathname and a query string.
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: {
          pathname: '/jobs',
          search: '?status=open',
          hash: '#ignored',
        },
      });

      const href = await triggerRedirect();
      // Should encode '/jobs?status=open' — hash must NOT be included.
      expect(href).toBe('/login?redirect=' + encodeURIComponent('/jobs?status=open'));
    }
  );

  it(
    'P20-003 (b): bare "/" path produces redirect=%2F',
    async () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: {
          pathname: '/',
          search: '',
          hash: '',
        },
      });

      const href = await triggerRedirect();
      expect(href).toBe('/login?redirect=' + encodeURIComponent('/'));
    }
  );

  it(
    'P20-003 (c): being on /login falls back to redirect=%2F (no loop)',
    async () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: {
          pathname: '/login',
          search: '?redirect=%2Fdashboard',
          hash: '',
        },
      });

      const href = await triggerRedirect();
      // Must fall back to '/' — not encode /login… into the redirect param.
      expect(href).toBe('/login?redirect=' + encodeURIComponent('/'));
    }
  );

  it(
    'P20-003 (c-variant): /login/sso sub-path also falls back to redirect=%2F',
    async () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: {
          pathname: '/login/sso',
          search: '',
          hash: '',
        },
      });

      const href = await triggerRedirect();
      expect(href).toBe('/login?redirect=' + encodeURIComponent('/'));
    }
  );

  it(
    'P20-003: hash is NOT included in the redirect param',
    async () => {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: {
          pathname: '/dashboard',
          search: '',
          hash: '#section-2',
        },
      });

      const href = await triggerRedirect();
      // Should be just '/dashboard', no hash.
      expect(href).toBe('/login?redirect=' + encodeURIComponent('/dashboard'));
    }
  );
});
