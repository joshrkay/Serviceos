/**
 * Finding 4 (WS6) — the "hold expiring" critical-proposal toast rendered
 * `proposal.expiresAt` with `new Date(iso).toLocaleTimeString()` (browser-local
 * tz), so the same hold showed a different expiry time for every viewer. It
 * must render in the TENANT timezone, deterministically, regardless of the JS
 * runtime timezone (CLAUDE.md: "stored UTC, rendered in tenant timezone").
 *
 * Clerk / useMe / voice / camera mocks mirror Shell.proposals.test.tsx so the
 * Shell renders cleanly under jsdom.
 */
import { _resetPendingProposalsCacheForTests } from '../../hooks/usePendingProposals';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { TenantTimezoneProvider } from '../../hooks/useTenantTimezone';

const __getToken = async () => 'tok-test';
const __useAuthResult = { isLoaded: true, isSignedIn: true, getToken: __getToken };
const __useUserResult = {
  isLoaded: true,
  user: {
    fullName: 'Jane Doe',
    primaryEmailAddress: { emailAddress: 'jane@example.com' },
  },
};
const __useClerkResult = { signOut: async () => {} };

vi.mock('@clerk/clerk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/clerk-react')>();
  return {
    ...actual,
    useAuth: () => __useAuthResult,
    useUser: () => __useUserResult,
    useClerk: () => __useClerkResult,
  };
});

vi.mock('../../hooks/useMe', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useMe')>(
    '../../hooks/useMe',
  );
  return {
    ...actual,
    useMe: () => ({
      me: {
        user_id: 'u-1',
        tenant_id: 't-1',
        role: 'owner',
        can_field_serve: true,
        current_mode: 'supervisor',
        mode_changed_at: null,
        permissions: [],
        backup_supervisor_user_id: null,
        unsupervised_proposal_routing: 'queue_and_sms',
      },
      isLoading: false,
      error: null,
      switchMode: vi.fn().mockResolvedValue(undefined),
      refetch: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

vi.mock('../shared/VoiceBar', () => ({ VoiceBar: () => null }));
vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: () => null,
  CameraButton: () => null,
}));

const toastWarning = vi.fn();
vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: {
    info: vi.fn(),
    warning: (...args: unknown[]) => toastWarning(...args),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { Shell } from './Shell';

const EMPTY_OK_JSON = { ok: true, json: async () => ({}) } as Response;

// The critical-proposal toast fires only when a proposal CROSSES INTO the 2h
// window between polls (the first poll seeds a baseline). So the proposal is
// far-future on poll 1 (not critical) and expiring at a fixed instant on
// poll 2. The fixed expiry instant is what must render in the tenant tz.
const EXPIRES_AT_UTC = '2026-05-18T21:00:00Z'; // within 2h of now (20:00Z)
const FAR_FUTURE_UTC = '2026-05-18T23:30:00Z'; // 3.5h out → not yet critical

function proposalListResponse(expiresAt: string): Response {
  return {
    ok: true,
    json: async () => ({
      data: [
        {
          id: 'p-crit',
          summary: 'Reschedule Tuesday',
          proposalType: 'reschedule_appointment',
          createdAt: '2026-05-18T00:00:00.000Z',
          expiresAt,
        },
      ],
      total: 1,
    }),
  } as Response;
}

function mockFetch() {
  const expiryQueue = [FAR_FUTURE_UTC, EXPIRES_AT_UTC];
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/proposals')) {
      const expiresAt = expiryQueue.length > 1 ? expiryQueue.shift()! : expiryQueue[0];
      return proposalListResponse(expiresAt);
    }
    return EMPTY_OK_JSON;
  });
}

function renderShellInTz(timezone: string) {
  return render(
    <TenantTimezoneProvider overrideTimezone={timezone}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/*" element={<Shell />} />
        </Routes>
      </MemoryRouter>
    </TenantTimezoneProvider>,
  );
}

describe('Finding 4 (WS6) — Shell critical-proposal toast tenant-tz expiry', () => {
  beforeEach(() => {
    _resetPendingProposalsCacheForTests();
    toastWarning.mockReset();
    vi.restoreAllMocks();
    // Now = 20:00Z; the proposal expires at 21:00Z (within 2h) so it is critical.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-18T20:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats the hold expiry in the tenant tz (NY), independent of process TZ', async () => {
    mockFetch();
    renderShellInTz('America/New_York');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
    // 21:00Z is 5:00 PM in New York (EDT, UTC-4) — NOT the process-local clock.
    const [message] = toastWarning.mock.calls[0] as [string, unknown];
    expect(message).toContain('Hold expiring 5:00 PM');
    expect(message).toContain('Reschedule Tuesday');
  });

  it('renders the SAME instant differently under a different tenant tz (LA)', async () => {
    mockFetch();
    renderShellInTz('America/Los_Angeles');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
    // Same instant, LA (PDT, UTC-7) → 2:00 PM.
    const [message] = toastWarning.mock.calls[0] as [string, unknown];
    expect(message).toContain('Hold expiring 2:00 PM');
  });
});
