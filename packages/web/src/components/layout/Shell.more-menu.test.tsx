/**
 * #1292 — mobile: a tap path to the five deep-link-only sections, plus a
 * small online/offline banner.
 *
 * Scope decision (2026-09-26, owner-approved): BUILD a "More" tab in the
 * supervisor mobile bottom bar that lists Schedule, Messages, Estimates,
 * Interactions and Digest (today reachable only via deep link — see
 * `Shell.tsx` getBottomNav L115-147), and a small online/offline banner.
 * DEFERRED: the conflict warning for concurrent jobs/customers edits
 * (last-write-wins) — tracked separately, not built here.
 *
 * Setup mirrors Shell-mode.test.tsx: Clerk + useMe are mocked so the Shell
 * renders cleanly under jsdom, and VoiceBar/CameraCapture are stubbed out
 * since they reach for browser media APIs this suite doesn't provide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

vi.mock('@clerk/clerk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/clerk-react')>();
  return {
    ...actual,
    useAuth: () => ({
      isLoaded: true,
      isSignedIn: true,
      getToken: async () => 'tok-test',
    }),
    useUser: () => ({
      isLoaded: true,
      user: {
        fullName: 'Jane Doe',
        primaryEmailAddress: { emailAddress: 'jane@example.com' },
      },
    }),
    useClerk: () => ({ signOut: vi.fn() }),
  };
});

vi.mock('../../hooks/useMe', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useMe')>(
    '../../hooks/useMe',
  );
  return {
    ...actual,
    useMe: vi.fn(),
  };
});

import { Shell } from './Shell';
import { useMe } from '../../hooks/useMe';
import type { MeResponse } from '../../hooks/useMe';

vi.mock('../shared/VoiceBar', () => ({
  VoiceBar: () => null,
}));
vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: () => null,
  CameraButton: () => null,
}));

function buildMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: 'u-1',
    tenant_id: 't-1',
    role: 'owner',
    can_field_serve: true,
    current_mode: 'supervisor',
    mode_changed_at: null,
    permissions: ['invoices:view', 'estimates:view', 'payments:view', 'settings:view'],
    backup_supervisor_user_id: null,
    unsupervised_proposal_routing: 'queue_and_sms',
    ...overrides,
  };
}

function mockMe(me: MeResponse) {
  vi.mocked(useMe).mockReturnValue({
    me,
    isLoading: false,
    error: null,
    switchMode: vi.fn().mockResolvedValue(undefined),
    refetch: vi.fn().mockResolvedValue(undefined),
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

describe('#1292 — Shell mobile "More" menu (supervisor bottom bar)', () => {
  beforeEach(() => {
    vi.mocked(useMe).mockReset();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  });

  it('renders a "More" tab in the supervisor mobile bottom bar', async () => {
    mockMe(buildMe({ current_mode: 'supervisor' }));
    renderShell();
    expect(await screen.findByTestId('mobile-more-tab')).toBeInTheDocument();
  });

  it('opens a menu listing the five deep-link-only sections when tapped', async () => {
    mockMe(buildMe({ current_mode: 'supervisor' }));
    renderShell();
    fireEvent.click(await screen.findByTestId('mobile-more-tab'));

    const sheet = await screen.findByTestId('mobile-more-sheet');
    const links = ['Schedule', 'Messages', 'Estimates', 'Interactions', 'Digest'];
    for (const label of links) {
      expect(within(sheet).getByText(label)).toBeInTheDocument();
    }
  });

  it('the More menu links point at the right routes', async () => {
    mockMe(buildMe({ current_mode: 'supervisor' }));
    renderShell();
    fireEvent.click(await screen.findByTestId('mobile-more-tab'));
    const sheet = await screen.findByTestId('mobile-more-sheet');

    expect(within(sheet).getByText('Schedule').closest('a')).toHaveAttribute('href', '/schedule');
    expect(within(sheet).getByText('Messages').closest('a')).toHaveAttribute('href', '/comms-inbox');
    expect(within(sheet).getByText('Estimates').closest('a')).toHaveAttribute('href', '/estimates');
    expect(within(sheet).getByText('Interactions').closest('a')).toHaveAttribute('href', '/interactions');
    expect(within(sheet).getByText('Digest').closest('a')).toHaveAttribute('href', '/digest');
  });

  it('hides the Estimates link when the viewer lacks estimates:view', async () => {
    mockMe(buildMe({ current_mode: 'supervisor', permissions: ['settings:view'] }));
    renderShell();
    fireEvent.click(await screen.findByTestId('mobile-more-tab'));
    const sheet = await screen.findByTestId('mobile-more-sheet');
    expect(within(sheet).queryByText('Estimates')).not.toBeInTheDocument();
    // Unguarded items still render.
    expect(within(sheet).getByText('Schedule')).toBeInTheDocument();
  });

  it('every More-menu link meets the >=44px glove tap target (min-h-11)', async () => {
    mockMe(buildMe({ current_mode: 'supervisor' }));
    renderShell();
    fireEvent.click(await screen.findByTestId('mobile-more-tab'));
    const sheet = await screen.findByTestId('mobile-more-sheet');
    const links = sheet.querySelectorAll('a');
    expect(links.length).toBeGreaterThan(0);
    links.forEach((a) => expect(a.className).toContain('min-h-11'));
  });

  it('tapping a More-menu link closes the sheet', async () => {
    mockMe(buildMe({ current_mode: 'supervisor' }));
    renderShell();
    fireEvent.click(await screen.findByTestId('mobile-more-tab'));
    const sheet = await screen.findByTestId('mobile-more-sheet');
    fireEvent.click(within(sheet).getByText('Schedule'));
    await waitFor(() => expect(screen.queryByTestId('mobile-more-sheet')).not.toBeInTheDocument());
  });

  it('does not render a More tab in tech mode (scope: supervisor bottom bar only)', async () => {
    mockMe(buildMe({ current_mode: 'tech', role: 'technician', can_field_serve: false }));
    renderShell();
    await waitFor(() => expect(screen.getAllByText('Today').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('mobile-more-tab')).not.toBeInTheDocument();
  });
});

describe('#1292 — Shell online/offline banner', () => {
  beforeEach(() => {
    vi.mocked(useMe).mockReset();
    mockMe(buildMe({ current_mode: 'supervisor' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);
  });

  afterEach(() => {
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  });

  it('shows no offline banner while online', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
    renderShell();
    await screen.findByText('Jane Doe');
    expect(screen.queryByTestId('offline-banner')).not.toBeInTheDocument();
  });

  it('shows an offline banner when the browser goes offline', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
    renderShell();
    await screen.findByText('Jane Doe');

    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    fireEvent(window, new Event('offline'));

    expect(await screen.findByTestId('offline-banner')).toBeInTheDocument();
  });

  it('hides the offline banner again once back online', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    renderShell();
    await screen.findByText('Jane Doe');
    expect(await screen.findByTestId('offline-banner')).toBeInTheDocument();

    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
    fireEvent(window, new Event('online'));

    await waitFor(() => expect(screen.queryByTestId('offline-banner')).not.toBeInTheDocument());
  });
});
