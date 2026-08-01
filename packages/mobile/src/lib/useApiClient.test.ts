// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiFetch } from './apiFetch';

interface CapturedConfig {
  baseUrl: string;
  getToken: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  onUnauthenticated: () => void;
}

const h = vi.hoisted(() => ({
  getToken: vi.fn().mockResolvedValue('jwt'),
  replace: vi.fn(),
  pathname: '/customers/c1',
  showToast: vi.fn(),
  client: vi.fn() as unknown as ApiFetch,
  config: undefined as unknown as CapturedConfig,
}));

vi.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ getToken: h.getToken }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: h.replace }),
  usePathname: () => h.pathname,
}));
vi.mock('../components/Toast', () => ({
  useToast: () => ({ showToast: h.showToast, showErrorToast: vi.fn(), hideToast: vi.fn() }),
}));
vi.mock('./env', () => ({ API_BASE_URL: 'https://api.test' }));
vi.mock('./apiFetch', () => ({
  createApiFetch: (cfg: CapturedConfig) => {
    h.config = cfg;
    return h.client;
  },
}));

// eslint-disable-next-line import/first
import { useApiClient } from './useApiClient';

beforeEach(() => {
  vi.clearAllMocks();
  h.pathname = '/customers/c1';
  h.config = undefined as unknown as CapturedConfig;
});

describe('useApiClient', () => {
  it('builds the client against the API base URL and returns it', () => {
    const { result } = renderHook(() => useApiClient());
    expect(result.current).toBe(h.client);
    expect(h.config.baseUrl).toBe('https://api.test');
  });

  it('requests the serviceos JWT template, mapping forceRefresh -> skipCache', async () => {
    renderHook(() => useApiClient());

    await h.config.getToken({ forceRefresh: true });
    expect(h.getToken).toHaveBeenCalledWith({ template: 'serviceos', skipCache: true });

    await h.config.getToken();
    expect(h.getToken).toHaveBeenLastCalledWith({ template: 'serviceos', skipCache: false });
  });

  it('surfaces a session-expired toast and routes to /sign-in preserving the route', () => {
    renderHook(() => useApiClient());
    h.config.onUnauthenticated();

    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Your session expired' }),
    );
    // Routes to the sign-in href carrying reason + the current route as `next`.
    expect(h.replace).toHaveBeenCalledTimes(1);
    const href = h.replace.mock.calls[0][0] as { pathname: string; params: Record<string, string> };
    expect(href.pathname).toBe('/sign-in');
    expect(href.params.reason).toBe('session-expired');
    expect(href.params.next).toBe('/customers/c1');
  });

  it('omits next from the sign-in route when on Home', () => {
    h.pathname = '/';
    renderHook(() => useApiClient());
    h.config.onUnauthenticated();
    const href = h.replace.mock.calls[0][0] as { pathname: string; params: Record<string, string> };
    expect(href.params.next).toBeUndefined();
  });
});
