// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Rendered via @testing-library/react under jsdom (root devDeps) so this runs
// in the root-only CI lane; useApiClient is mocked, so its mobile-only
// transitive deps never load.
const h = vi.hoisted(() => ({
  apiFn: vi.fn(),
}));

vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.apiFn }));

// eslint-disable-next-line import/first
import {
  useOnboardingStatus,
  skipSetupGateForSession,
  isSetupGateSkippedForSession,
  _resetSetupGateSkipForTests,
} from './useOnboardingStatus';

/** Flush pending microtasks (one macrotask drains the awaited promise chain). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function statusResponse(identityStatus: string) {
  return {
    steps: [{ id: 'identity', status: identityStatus }],
    currentStep: 'identity',
    isComplete: false,
    voiceAgentLive: false,
    tenantId: 't1',
    subscriptionStatus: 'trialing',
  };
}

function mockOk(body: unknown) {
  h.apiFn.mockResolvedValue({ ok: true, json: async () => body });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSetupGateSkipForTests();
});

afterEach(() => {
  cleanup();
});

describe('useOnboardingStatus', () => {
  it('reports setup incomplete when the identity step is not done', async () => {
    mockOk(statusResponse('current'));
    const { result } = renderHook(() => useOnboardingStatus(true));

    await act(async () => {
      await flush();
    });

    expect(h.apiFn).toHaveBeenCalledWith('/api/onboarding/status');
    expect(result.current.isSetupComplete).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('reports setup complete when the identity step is done', async () => {
    mockOk(statusResponse('done'));
    const { result } = renderHook(() => useOnboardingStatus(true));

    await act(async () => {
      await flush();
    });

    expect(result.current.isSetupComplete).toBe(true);
  });

  it('does not fetch when disabled', async () => {
    const { result } = renderHook(() => useOnboardingStatus(false));

    await act(async () => {
      await flush();
    });

    expect(h.apiFn).not.toHaveBeenCalled();
    expect(result.current.isSetupComplete).toBeNull();
  });

  it('fails open: a status outage leaves isSetupComplete null', async () => {
    h.apiFn.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useOnboardingStatus(true));

    await act(async () => {
      await flush();
    });

    expect(result.current.isSetupComplete).toBeNull();
    expect(result.current.error).toBeTruthy();
    expect(result.current.isLoading).toBe(false);
  });

  it('TTL-guards the refetch so route changes do not spam the endpoint', async () => {
    mockOk(statusResponse('done'));
    const { result } = renderHook(() => useOnboardingStatus(true));

    await act(async () => {
      await flush();
    });
    expect(h.apiFn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refetch();
    });
    // Within the TTL the refetch is a no-op.
    expect(h.apiFn).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit session skip per user', () => {
    expect(isSetupGateSkippedForSession('u1')).toBe(false);
    skipSetupGateForSession('u1');
    expect(isSetupGateSkippedForSession('u1')).toBe(true);
    expect(isSetupGateSkippedForSession('u2')).toBe(false);
    expect(isSetupGateSkippedForSession(null)).toBe(false);
  });
});
