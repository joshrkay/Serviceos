/**
 * #1283 — mobile bar (CLAUDE.md): every Shell tap target ≥44px, no overflow at
 * 320px. jsdom can't measure layout, so this pins the CSS class contract
 * (`size-11` / `min-h-11` + `min-w-11` = 44px); the measured check lives in
 * e2e/shell-mobile.spec.ts (Playwright, 320px viewport).
 *
 * Also #1280 — a viewer without settings:view (the technician role) must not
 * have the mobile avatar deep-link into /settings (now route-guarded); it
 * opens an account sheet with Sign out instead, so a technician on a phone
 * still has a way to sign out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

const signOutMock = vi.fn();
vi.mock('@clerk/clerk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/clerk-react')>();
  return {
    ...actual,
    useAuth: () => ({ isLoaded: true, isSignedIn: true, getToken: async () => 'tok-test' }),
    useUser: () => ({
      isLoaded: true,
      user: { fullName: 'Jane Doe', primaryEmailAddress: { emailAddress: 'jane@example.com' } },
    }),
    useClerk: () => ({ signOut: signOutMock }),
  };
});

vi.mock('../../hooks/useMe', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useMe')>('../../hooks/useMe');
  return { ...actual, useMe: vi.fn() };
});

vi.mock('../shared/VoiceBar', () => ({ VoiceBar: () => null }));

import { Shell } from './Shell';
import { CameraButton } from '../shared/CameraCapture';
import { useMe } from '../../hooks/useMe';
import type { MeResponse } from '../../hooks/useMe';

const OWNER_PERMS = ['invoices:view', 'estimates:view', 'payments:view', 'settings:view'];

function mockMe(overrides: Partial<MeResponse> = {}) {
  vi.mocked(useMe).mockReturnValue({
    me: {
      user_id: 'u-1',
      tenant_id: 't-1',
      role: 'owner',
      can_field_serve: true,
      current_mode: 'supervisor',
      mode_changed_at: null,
      permissions: OWNER_PERMS,
      backup_supervisor_user_id: null,
      unsupervised_proposal_routing: 'queue_and_sms',
      ...overrides,
    },
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

/** 44px in both dimensions: `size-11`, or `min-h-11` + `min-w-11`. */
function expectTapTarget(el: Element, what: string) {
  const cls = el.getAttribute('class') ?? '';
  const tall = /(^|\s)(size-11|min-h-11)(\s|$)/.test(cls);
  const wide = /(^|\s)(size-11|min-w-11)(\s|$)/.test(cls);
  expect(tall && wide, `${what} must be ≥44×44 (class="${cls}")`).toBe(true);
}

describe('#1283 — Shell mobile tap targets', () => {
  beforeEach(() => {
    vi.mocked(useMe).mockReset();
    signOutMock.mockReset();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);
  });

  it('topbar approval bell is ≥44×44', async () => {
    mockMe();
    renderShell();
    expectTapTarget(await screen.findByTestId('mobile-inbox-bell'), 'approval bell');
  });

  it('topbar avatar / settings link is ≥44×44', async () => {
    mockMe();
    renderShell();
    const avatar = await screen.findByTestId('mobile-account-button');
    expectTapTarget(avatar, 'avatar');
    expect(avatar.getAttribute('href')).toBe('/settings');
  });

  it('topbar mode-toggle segments are ≥44×44', async () => {
    mockMe();
    renderShell();
    const toggles = await screen.findAllByTestId('mode-toggle');
    // The mobile (topbar) instance is the one inside the md:hidden bar.
    const topbar = toggles.find((t) => t.closest('[data-testid="mobile-topbar"]'));
    expect(topbar, 'topbar mode toggle').toBeDefined();
    for (const seg of within(topbar!).getAllByRole('radio')) {
      expectTapTarget(seg, `mode segment ${seg.getAttribute('aria-label')}`);
    }
  });

  it('the topbar row cannot grow past a 320px screen: logo wordmark hides at the narrowest width', async () => {
    mockMe();
    renderShell();
    const bar = await screen.findByTestId('mobile-topbar');
    const wordmark = within(bar).getByText('Rivet');
    // 24px padding + 24px logo + 132px toggle + 3×44px icons = 312px ≤ 320.
    expect(wordmark.className).toMatch(/hidden/);
    expect(wordmark.className).toMatch(/min-\[360px\]:inline/);
    expect(bar.className).toMatch(/(^|\s)px-3(\s|$)/);
  });

  it('bottom tab bar items are ≥44px tall', async () => {
    mockMe();
    renderShell();
    const bottom = await screen.findByTestId('mobile-bottom-nav');
    const links = within(bottom).getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.className, `bottom tab ${link.textContent}`).toMatch(/(^|\s)min-h-11(\s|$)/);
    }
  });

  it('topbar camera button is ≥44×44', () => {
    render(<CameraButton variant="topbar" onOpen={() => undefined} />);
    expectTapTarget(screen.getByRole('button', { name: /open camera/i }), 'camera button');
  });
});

describe('#1280 — technician avatar opens an account sheet, not /settings', () => {
  beforeEach(() => {
    vi.mocked(useMe).mockReset();
    signOutMock.mockReset();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);
  });

  it('a viewer without settings:view gets an account button with Sign out', async () => {
    mockMe({ role: 'technician', can_field_serve: true, current_mode: 'tech', permissions: ['jobs:view'] });
    renderShell();
    const avatar = await screen.findByTestId('mobile-account-button');
    expect(avatar.tagName).toBe('BUTTON');
    expect(avatar.getAttribute('href')).toBeNull();
    expectTapTarget(avatar, 'technician avatar');

    fireEvent.click(avatar);
    const sheet = await screen.findByTestId('mobile-account-sheet');
    fireEvent.click(within(sheet).getByRole('button', { name: /sign out/i }));
    expect(signOutMock).toHaveBeenCalledWith({ redirectUrl: '/login' });
  });
});
