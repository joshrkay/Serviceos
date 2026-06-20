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
  client: vi.fn() as unknown as ApiFetch,
  config: undefined as unknown as CapturedConfig,
}));

vi.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ getToken: h.getToken }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: h.replace }) }));
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

  it('routes to /sign-in when the API reports the session is unauthenticated', () => {
    renderHook(() => useApiClient());
    h.config.onUnauthenticated();
    expect(h.replace).toHaveBeenCalledWith('/sign-in');
  });
});
