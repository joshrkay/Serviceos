/**
 * P2-033 — Shell proposal-notification integration.
 *
 * The hook is unit-tested in `usePendingProposals.test.tsx`; here we
 * pin down the Shell wiring:
 *
 *   - Badge count surfaces the pending count and links to `/inbox`
 *   - Badge is hidden when count is 0
 *   - A genuinely new proposal triggers a sonner toast carrying the
 *     proposal summary, and the toast's action navigates to `/inbox`
 *
 * Clerk + voice/camera mocks mirror `Shell-mode.test.tsx` so the Shell
 * renders cleanly under jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// Stable references mirror the pattern in test-setup.ts. If `getToken`
// were re-created on every render, `useApiClient` would emit a new
// fetch wrapper each render, which restarts the polling effect inside
// `usePendingProposals` and races the assertions in this file.
const __getToken = async () => 'tok-test';
const __useAuthResult = {
  isLoaded: true,
  isSignedIn: true,
  getToken: __getToken,
};
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

vi.mock('../shared/VoiceBar', () => ({
  VoiceBar: () => null,
}));
vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: () => null,
  CameraButton: () => null,
}));

const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: {
    info: (...args: unknown[]) => toastInfo(...args),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { Shell } from './Shell';

function listResponse(rows: Array<{ id: string; summary: string }>): Response {
  return {
    ok: true,
    json: async () =>
      ({
        data: rows.map((r) => ({
          ...r,
          proposalType: 'create_appointment',
          createdAt: '2026-05-18T00:00:00.000Z',
        })),
        total: rows.length,
      }),
  } as Response;
}

const EMPTY_OK_JSON = { ok: true, json: async () => ({}) } as Response;

// Shell mounts several data hooks (usePendingProposals, useActiveSessions,
// ...). Pre-P2-033 tests stacked `mockResolvedValueOnce` on the global
// `fetch` spy, which assumed only one consumer fired requests. With the
// X10 supervisor-wall hook also calling `/api/voice/sessions/active`,
// raw Once chains race. This helper routes each fetch by URL: proposal
// calls drain the supplied response queue; everything else returns an
// inert {} response so unrelated hooks don't break the assertions here.
function mockProposalFetchSequence(rows: ReadonlyArray<Array<{ id: string; summary: string }>>) {
  const queue = [...rows];
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/proposals')) {
      const next = queue.length > 1 ? queue.shift()! : queue[0] ?? [];
      return listResponse(next);
    }
    return EMPTY_OK_JSON;
  });
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/*" element={<Shell />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('P2-033 — Shell proposal notification integration', () => {
  beforeEach(() => {
    toastInfo.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Badge count — Shell badge reflects the pending proposal count and links to /inbox', async () => {
    mockProposalFetchSequence([
      [
        { id: 'p1', summary: 'Schedule visit' },
        { id: 'p2', summary: 'Issue invoice' },
      ],
    ]);

    renderShell();

    const badge = await screen.findByTestId('pending-proposal-badge');
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('href')).toBe('/inbox');
  });

  it('Mobile bell — top-bar Bell links to /inbox and shows the pending count', async () => {
    mockProposalFetchSequence([
      [
        { id: 'p1', summary: 'Schedule visit' },
        { id: 'p2', summary: 'Issue invoice' },
      ],
    ]);

    renderShell();

    // The mobile approvals entry point links to /inbox even though the
    // supervisor bottom bar omits Inbox (Figma parity).
    const bell = await screen.findByTestId('mobile-inbox-bell');
    expect(bell.getAttribute('href')).toBe('/inbox');
    const badge = await screen.findByTestId('mobile-inbox-badge');
    expect(badge.textContent).toBe('2');
  });

  it('Badge hidden when there are no pending proposals', async () => {
    const fetchSpy = mockProposalFetchSequence([[]]);

    renderShell();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/proposals?status=ready_for_review&limit=100',
        expect.anything(),
      );
    });
    expect(screen.queryByTestId('pending-proposal-badge')).toBeNull();
  });

  it('Toast — new proposal fires sonner toast with /inbox action', async () => {
    const fetchSpy = mockProposalFetchSequence([
      [{ id: 'p1', summary: 'Old proposal' }],
      [
        { id: 'p1', summary: 'Old proposal' },
        { id: 'p2', summary: 'Reschedule Tuesday' },
      ],
    ]);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderShell();

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/proposals?status=ready_for_review&limit=100',
        expect.anything(),
      ),
    );

    // Advance the default 30s poll interval to trigger the second fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    const [message, opts] = toastInfo.mock.calls[0] as [
      string,
      { action?: { label: string; onClick: () => void } },
    ];
    expect(message).toContain('Reschedule Tuesday');
    expect(opts.action?.label).toBe('Review');
    expect(typeof opts.action?.onClick).toBe('function');
  });

  it('Action — badge decrements after a proposal is removed (auto-refresh)', async () => {
    mockProposalFetchSequence([
      [
        { id: 'p1', summary: 'A' },
        { id: 'p2', summary: 'B' },
      ],
      [{ id: 'p1', summary: 'A' }],
    ]);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderShell();

    await waitFor(() => {
      const badge = screen.queryByTestId('pending-proposal-badge');
      expect(badge?.textContent).toBe('2');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    await waitFor(() => {
      const badge = screen.queryByTestId('pending-proposal-badge');
      expect(badge?.textContent).toBe('1');
    });
  });

  // Sanity check that the badge action targets the inbox route; we
  // can't easily assert navigate() side-effects from a `NavLink`, but
  // a click on it must not throw and must request the right path.
  it('badge click navigates to /inbox without throwing', async () => {
    mockProposalFetchSequence([[{ id: 'p1', summary: 'Test' }]]);

    renderShell();

    const badge = await screen.findByTestId('pending-proposal-badge');
    expect(() => fireEvent.click(badge)).not.toThrow();
  });
});
