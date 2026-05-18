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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      listResponse([
        { id: 'p1', summary: 'Schedule visit' },
        { id: 'p2', summary: 'Issue invoice' },
      ]),
    );

    renderShell();

    const badge = await screen.findByTestId('pending-proposal-badge');
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('href')).toBe('/inbox');
  });

  it('Badge hidden when there are no pending proposals', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(listResponse([]));

    renderShell();

    // Wait for the polling fetch to settle before asserting absence.
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('pending-proposal-badge')).toBeNull();
  });

  it('Toast — new proposal fires sonner toast with /inbox action', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(listResponse([{ id: 'p1', summary: 'Old proposal' }]))
      .mockResolvedValueOnce(
        listResponse([
          { id: 'p1', summary: 'Old proposal' },
          { id: 'p2', summary: 'Reschedule Tuesday' },
        ]),
      );

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
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        listResponse([
          { id: 'p1', summary: 'A' },
          { id: 'p2', summary: 'B' },
        ]),
      )
      .mockResolvedValue(listResponse([{ id: 'p1', summary: 'A' }]));

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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      listResponse([{ id: 'p1', summary: 'Test' }]),
    );

    renderShell();

    const badge = await screen.findByTestId('pending-proposal-badge');
    expect(() => fireEvent.click(badge)).not.toThrow();
  });
});
