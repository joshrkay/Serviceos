// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@ai-service-os/shared';

// Rendered via @testing-library/react under jsdom (root devDeps) so this runs
// in the root-only CI lane; @clerk/clerk-expo + the api/me + useApiClient
// modules are mocked, so their mobile-only transitive deps never load.
const h = vi.hoisted(() => ({
  auth: {
    userId: null as string | null,
    orgId: null as string | null,
    sessionId: null as string | null,
  },
  fetchMe: vi.fn(),
  postModeSwitch: vi.fn(),
  apiFn: vi.fn(),
}));

vi.mock('@clerk/clerk-expo', () => ({ useAuth: () => h.auth }));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.apiFn }));
vi.mock('../api/me', () => ({ fetchMe: h.fetchMe, postModeSwitch: h.postModeSwitch }));

// eslint-disable-next-line import/first
import { useMe, _resetMeCacheForTests } from './useMe';

/** Flush pending microtasks (one macrotask drains the awaited promise chain). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeMe(over: Partial<MeResponse>): MeResponse {
  return {
    user_id: 'u',
    tenant_id: 't',
    role: 'supervisor',
    can_field_serve: true,
    current_mode: 'both',
    mode_changed_at: null,
    permissions: [],
    backup_supervisor_user_id: null,
    unsupervised_proposal_routing: 'queue_only',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetMeCacheForTests();
  h.auth = { userId: 'userA', orgId: 'orgA', sessionId: 'sessA' };
});

afterEach(() => {
  cleanup();
});

describe('useMe', () => {
  it('loads /api/me for the current identity', async () => {
    h.fetchMe.mockResolvedValue(makeMe({ tenant_id: 'tA' }));
    const { result } = renderHook(() => useMe());

    await act(async () => {
      await flush();
    });

    expect(result.current.me?.tenant_id).toBe('tA');
    expect(result.current.isLoading).toBe(false);
  });

  it('refetches when the Clerk session changes even if userId/orgId are unchanged', async () => {
    // tenant_id (the API's real tenant boundary) rides the session token, and
    // orgId can be null, so a sign-out/sign-in (new sessionId) must re-key the
    // cache rather than serve the prior tenant's payload.
    h.fetchMe
      .mockResolvedValueOnce(makeMe({ tenant_id: 'tA' }))
      .mockResolvedValueOnce(makeMe({ tenant_id: 'tB' }));

    const { result, rerender } = renderHook(() => useMe());
    await act(async () => {
      await flush();
    });
    expect(result.current.me?.tenant_id).toBe('tA');

    await act(async () => {
      h.auth = { userId: 'userA', orgId: 'orgA', sessionId: 'sessB' }; // same user/org, new session
      rerender();
      await flush();
    });

    expect(h.fetchMe).toHaveBeenCalledTimes(2);
    expect(result.current.me?.tenant_id).toBe('tB');
  });

  it('ignores a slow prior-identity response that resolves after an identity switch', async () => {
    // fetchMe hands back a fresh deferred per call: [0] = identity A, [1] = B.
    const resolvers: Array<(m: MeResponse) => void> = [];
    h.fetchMe.mockImplementation(
      () => new Promise<MeResponse>((resolve) => resolvers.push(resolve)),
    );

    const { result, rerender } = renderHook(() => useMe());
    await act(async () => {
      await flush(); // load A in flight (resolvers[0])
    });

    // Identity switches before A resolves.
    await act(async () => {
      h.auth = { userId: 'userB', orgId: 'orgB', sessionId: 'sessB' };
      rerender();
      await flush(); // load B in flight (resolvers[1])
    });
    expect(resolvers).toHaveLength(2);

    // Newer load (B) resolves first, then the stale older load (A) resolves last.
    await act(async () => {
      resolvers[1](makeMe({ tenant_id: 'tB' }));
      await flush();
    });
    await act(async () => {
      resolvers[0](makeMe({ tenant_id: 'tA' }));
      await flush();
    });

    // The stale A response must NOT overwrite B.
    expect(result.current.me?.tenant_id).toBe('tB');
    expect(result.current.isLoading).toBe(false);
  });
});
