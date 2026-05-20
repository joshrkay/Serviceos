import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// The global test-setup mocks `useAuth` only. Shell uses `useUser` and
// `useClerk` directly, so we extend the Clerk mock here. The
// `vi.importActual` chain ensures other clerk-react exports remain real.
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

// Mock useMe so we can drive the mode + role independently of the API.
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

// Suppress voice + camera button mounts that rely on browser APIs we
// don't stub for this test surface.
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
    permissions: [],
    backup_supervisor_user_id: null,
    unsupervised_proposal_routing: 'queue_and_sms',
    ...overrides,
  };
}

function mockMe(me: MeResponse, switchMode = vi.fn().mockResolvedValue(undefined)) {
  vi.mocked(useMe).mockReturnValue({
    me,
    isLoading: false,
    error: null,
    switchMode,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
  return switchMode;
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

describe('P12-002 — Shell mode-aware nav + toggle visibility', () => {
  beforeEach(() => {
    vi.mocked(useMe).mockReset();
    // P2-033 — Shell mounts usePendingProposals on render. Stub fetch
    // so it resolves to an empty list and any setState happens inside
    // an act-flushed promise tick, avoiding noisy "update not wrapped
    // in act" warnings in this file's tests (which don't exercise the
    // proposal-notification UI).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], total: 0 }),
    } as Response);
  });

  it('shows the mode toggle for an owner', () => {
    mockMe(buildMe({ role: 'owner', can_field_serve: true }));
    renderShell();
    expect(screen.getAllByTestId('mode-toggle').length).toBeGreaterThan(0);
  });

  it('shows the mode toggle for a dispatcher with can_field_serve=true', () => {
    mockMe(buildMe({ role: 'dispatcher', can_field_serve: true }));
    renderShell();
    expect(screen.getAllByTestId('mode-toggle').length).toBeGreaterThan(0);
  });

  it('hides the mode toggle for a dispatcher with can_field_serve=false', () => {
    mockMe(buildMe({ role: 'dispatcher', can_field_serve: false }));
    renderShell();
    expect(screen.queryByTestId('mode-toggle')).toBeNull();
  });

  it('hides the mode toggle for a technician', () => {
    mockMe(buildMe({ role: 'technician', can_field_serve: false, current_mode: 'tech' }));
    renderShell();
    expect(screen.queryByTestId('mode-toggle')).toBeNull();
  });

  it('renders supervisor-mode nav (Sessions, Leads, Interactions)', () => {
    mockMe(buildMe({ current_mode: 'supervisor' }));
    renderShell();
    // Sessions = relabeled /assistant in supervisor mode.
    expect(screen.getAllByText('Sessions').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Leads').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Interactions').length).toBeGreaterThan(0);
  });

  it('renders tech-mode nav (Today, My jobs) and omits supervisor-only items', () => {
    mockMe(buildMe({ current_mode: 'tech' }));
    renderShell();
    expect(screen.getAllByText('Today').length).toBeGreaterThan(0);
    expect(screen.getAllByText('My jobs').length).toBeGreaterThan(0);
    // Supervisor-only items must be absent in tech mode.
    expect(screen.queryByText('Leads')).toBeNull();
    expect(screen.queryByText('Interactions')).toBeNull();
    expect(screen.queryByText('Sessions')).toBeNull();
  });

  it('renders both-mode nav (Sessions + Today + My jobs together)', () => {
    mockMe(buildMe({ current_mode: 'both' }));
    renderShell();
    expect(screen.getAllByText('Sessions').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Today').length).toBeGreaterThan(0);
    expect(screen.getAllByText('My jobs').length).toBeGreaterThan(0);
  });

  it('reflects current_mode on document.body via data-mode', async () => {
    mockMe(buildMe({ current_mode: 'tech' }));
    renderShell();
    await waitFor(() =>
      expect(document.body.getAttribute('data-mode')).toBe('tech'),
    );
  });

  it('replaces the hardcoded Owner label with the role-derived label', () => {
    mockMe(buildMe({ role: 'dispatcher', can_field_serve: false }));
    renderShell();
    expect(screen.getByText('Dispatcher')).toBeInTheDocument();
  });
});
