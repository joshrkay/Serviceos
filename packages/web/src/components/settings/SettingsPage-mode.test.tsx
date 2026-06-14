import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { MeResponse } from '../../hooks/useMe';

// Suppress dependent modules that pull in browser APIs / clerk / images.
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
        fullName: 'Owner User',
        primaryEmailAddress: { emailAddress: 'owner@example.com' },
      },
    }),
    useClerk: () => ({ signOut: vi.fn() }),
  };
});

vi.mock('../jobs/SuppliersSheet', () => ({ SuppliersSheet: () => null }));
vi.mock('./QuickBooksIntegrationSheet', () => ({
  QuickBooksIntegrationSheet: () => null,
}));
vi.mock('../../hooks/useMe', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useMe')>(
    '../../hooks/useMe',
  );
  return { ...actual, useMe: vi.fn() };
});
vi.mock('../../api/tenant-settings', () => ({
  updateTenantModeSettings: vi.fn(),
}));
// The section loads the roster via the authed client; return a
// deterministic fixture (with a technician that must be filtered out).
const rosterFetch = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => rosterFetch,
}));

import { useMe } from '../../hooks/useMe';
import { updateTenantModeSettings } from '../../api/tenant-settings';
import { SettingsPage } from './SettingsPage';

const ROSTER = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'owner@example.com',
    role: 'owner',
    firstName: 'Olive',
    lastName: 'Owner',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    email: 'dispatch@example.com',
    role: 'dispatcher',
    firstName: 'Dana',
    lastName: 'Dispatch',
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    email: 'tech@example.com',
    role: 'technician',
    firstName: 'Ted',
    lastName: 'Tech',
  },
];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

function buildMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: 'u-1',
    tenant_id: 't-1',
    role: 'owner',
    can_field_serve: true,
    current_mode: 'supervisor',
    mode_changed_at: null,
    permissions: ['settings:update'],
    backup_supervisor_user_id: null,
    unsupervised_proposal_routing: 'queue_and_sms',
    ...overrides,
  };
}

function mockMe(overrides: Partial<MeResponse> = {}) {
  vi.mocked(useMe).mockReturnValue({
    me: buildMe(overrides),
    isLoading: false,
    error: null,
    switchMode: vi.fn().mockResolvedValue(undefined),
    refetch: vi.fn().mockResolvedValue(undefined),
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe('P12-005-fe — SettingsPage Supervisor backup section', () => {
  beforeEach(() => {
    vi.mocked(useMe).mockReset();
    vi.mocked(updateTenantModeSettings).mockReset();
    rosterFetch.mockReset();
    rosterFetch.mockResolvedValue(jsonResponse({ data: ROSTER }));
  });

  it('renders the section for an owner with all three routing options', () => {
    mockMe({ role: 'owner' });
    renderPage();
    expect(screen.getByTestId('supervisor-backup-section')).toBeInTheDocument();
    expect(screen.getByTestId('routing-option-queue_and_sms')).toBeInTheDocument();
    expect(screen.getByTestId('routing-option-queue_only')).toBeInTheDocument();
    expect(
      screen.getByTestId('routing-option-escalate_to_oncall'),
    ).toBeInTheDocument();
    // Default selection is queue_and_sms.
    expect(
      within(screen.getByTestId('routing-option-queue_and_sms')).getByRole(
        'radio',
      ),
    ).toBeChecked();
  });

  it('hides the section for a dispatcher', () => {
    mockMe({ role: 'dispatcher' });
    renderPage();
    expect(screen.queryByTestId('supervisor-backup-section')).toBeNull();
  });

  it('hides the section while me is loading (null)', () => {
    vi.mocked(useMe).mockReturnValue({
      me: null,
      isLoading: true,
      error: null,
      switchMode: vi.fn().mockResolvedValue(undefined),
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    renderPage();
    expect(screen.queryByTestId('supervisor-backup-section')).toBeNull();
  });

  it('picker lists only supervise-capable users (no technicians) plus None', async () => {
    mockMe({ role: 'owner' });
    renderPage();

    const select = screen.getByTestId('backup-supervisor-select');
    await waitFor(() =>
      expect(within(select).getAllByRole('option')).toHaveLength(3),
    );
    const labels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels[0]).toBe('None');
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Olive Owner'),
        expect.stringContaining('Dana Dispatch'),
      ]),
    );
    expect(labels.join('|')).not.toContain('Ted Tech');
  });

  it('saves both fields via the typed wrapper on Save click (round trip)', async () => {
    mockMe({
      role: 'owner',
      backup_supervisor_user_id: null,
      unsupervised_proposal_routing: 'queue_and_sms',
    });
    vi.mocked(updateTenantModeSettings).mockResolvedValue();

    const user = userEvent.setup();
    renderPage();

    const select = screen.getByTestId('backup-supervisor-select');
    await waitFor(() =>
      expect(within(select).getAllByRole('option').length).toBeGreaterThan(1),
    );
    await user.selectOptions(select, '22222222-2222-2222-2222-222222222222');
    await user.click(screen.getByTestId('routing-option-queue_only'));
    await user.click(screen.getByTestId('supervisor-backup-save'));

    await waitFor(() =>
      expect(updateTenantModeSettings).toHaveBeenCalledTimes(1),
    );
    const [, payload] = vi.mocked(updateTenantModeSettings).mock.calls[0];
    expect(payload).toEqual({
      backupSupervisorUserId: '22222222-2222-2222-2222-222222222222',
      unsupervisedProposalRouting: 'queue_only',
    });
    // Optimistic: the chosen values stick after a successful save.
    expect(
      (screen.getByTestId('backup-supervisor-select') as HTMLSelectElement)
        .value,
    ).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('reverts to last-saved values when the save fails', async () => {
    mockMe({
      role: 'owner',
      backup_supervisor_user_id: '11111111-1111-1111-1111-111111111111',
      unsupervised_proposal_routing: 'queue_and_sms',
    });
    vi.mocked(updateTenantModeSettings).mockRejectedValue(
      new Error('boom 500'),
    );

    const user = userEvent.setup();
    renderPage();

    const select = screen.getByTestId('backup-supervisor-select');
    await waitFor(() =>
      expect(within(select).getAllByRole('option').length).toBeGreaterThan(1),
    );
    await user.selectOptions(select, '22222222-2222-2222-2222-222222222222');
    await user.click(screen.getByTestId('routing-option-escalate_to_oncall'));
    await user.click(screen.getByTestId('supervisor-backup-save'));

    await waitFor(() =>
      expect(updateTenantModeSettings).toHaveBeenCalledTimes(1),
    );
    // Both controls revert to the last-saved values.
    await waitFor(() =>
      expect(
        (screen.getByTestId('backup-supervisor-select') as HTMLSelectElement)
          .value,
      ).toBe('11111111-1111-1111-1111-111111111111'),
    );
    expect(
      within(screen.getByTestId('routing-option-queue_and_sms')).getByRole(
        'radio',
      ),
    ).toBeChecked();
  });

  it('selecting None clears the backup (sends null)', async () => {
    mockMe({
      role: 'owner',
      backup_supervisor_user_id: '11111111-1111-1111-1111-111111111111',
    });
    vi.mocked(updateTenantModeSettings).mockResolvedValue();

    const user = userEvent.setup();
    renderPage();

    const select = screen.getByTestId('backup-supervisor-select');
    await waitFor(() =>
      expect(within(select).getAllByRole('option').length).toBeGreaterThan(1),
    );
    await user.selectOptions(select, '');
    await user.click(screen.getByTestId('supervisor-backup-save'));

    await waitFor(() =>
      expect(updateTenantModeSettings).toHaveBeenCalledTimes(1),
    );
    const [, payload] = vi.mocked(updateTenantModeSettings).mock.calls[0];
    expect(payload.backupSupervisorUserId).toBeNull();
  });
});
