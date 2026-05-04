import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
vi.mock('./QuickBooksModal', () => ({ QuickBooksModal: () => null }));
vi.mock('../../hooks/useMe', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useMe')>(
    '../../hooks/useMe',
  );
  return { ...actual, useMe: vi.fn() };
});
vi.mock('../../api/tenant-settings', () => ({
  updateTenantModeSettings: vi.fn(),
}));

import { useMe } from '../../hooks/useMe';
import { updateTenantModeSettings } from '../../api/tenant-settings';
import { SettingsPage } from './SettingsPage';

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
  });

  it('renders the section for an owner', () => {
    vi.mocked(useMe).mockReturnValue({
      me: buildMe({ role: 'owner' }),
      isLoading: false,
      error: null,
      switchMode: vi.fn().mockResolvedValue(undefined),
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    renderPage();
    expect(screen.getByTestId('supervisor-backup-section')).toBeInTheDocument();
    expect(screen.getByTestId('routing-option-queue_and_sms')).toBeInTheDocument();
    expect(screen.getByTestId('routing-option-queue_only')).toBeInTheDocument();
    expect(screen.getByTestId('routing-option-escalate_to_oncall')).toBeInTheDocument();
  });

  it('hides the section for a dispatcher', () => {
    vi.mocked(useMe).mockReturnValue({
      me: buildMe({ role: 'dispatcher' }),
      isLoading: false,
      error: null,
      switchMode: vi.fn().mockResolvedValue(undefined),
      refetch: vi.fn().mockResolvedValue(undefined),
    });
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

  it('saves both fields via PUT /api/settings on Save click', async () => {
    vi.mocked(useMe).mockReturnValue({
      me: buildMe({
        role: 'owner',
        backup_supervisor_user_id: null,
        unsupervised_proposal_routing: 'queue_and_sms',
      }),
      isLoading: false,
      error: null,
      switchMode: vi.fn().mockResolvedValue(undefined),
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(updateTenantModeSettings).mockResolvedValue();

    const user = userEvent.setup();
    renderPage();

    // Set a backup user id.
    const input = screen.getByTestId('backup-supervisor-input');
    await user.clear(input);
    await user.type(input, '11111111-1111-1111-1111-111111111111');

    // Pick a different routing.
    await user.click(screen.getByTestId('routing-option-queue_only'));

    await user.click(screen.getByTestId('supervisor-backup-save'));

    await waitFor(() =>
      expect(updateTenantModeSettings).toHaveBeenCalledTimes(1),
    );
    const [, payload] = vi.mocked(updateTenantModeSettings).mock.calls[0];
    expect(payload).toEqual({
      backupSupervisorUserId: '11111111-1111-1111-1111-111111111111',
      unsupervisedProposalRouting: 'queue_only',
    });
  });

  it('blocks save when the backup user id is not a valid UUID', async () => {
    vi.mocked(useMe).mockReturnValue({
      me: buildMe({ role: 'owner' }),
      isLoading: false,
      error: null,
      switchMode: vi.fn().mockResolvedValue(undefined),
      refetch: vi.fn().mockResolvedValue(undefined),
    });

    const user = userEvent.setup();
    renderPage();

    const input = screen.getByTestId('backup-supervisor-input');
    await user.type(input, 'not-a-uuid');

    expect(screen.getByText(/Must be a valid UUID/i)).toBeInTheDocument();
    expect(screen.getByTestId('supervisor-backup-save')).toBeDisabled();
  });

  it('explicit empty string clears the backup (sends null)', async () => {
    vi.mocked(useMe).mockReturnValue({
      me: buildMe({
        role: 'owner',
        backup_supervisor_user_id: '11111111-1111-1111-1111-111111111111',
      }),
      isLoading: false,
      error: null,
      switchMode: vi.fn().mockResolvedValue(undefined),
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(updateTenantModeSettings).mockResolvedValue();

    const user = userEvent.setup();
    renderPage();

    const input = screen.getByTestId('backup-supervisor-input');
    await user.clear(input);
    await user.click(screen.getByTestId('supervisor-backup-save'));

    await waitFor(() =>
      expect(updateTenantModeSettings).toHaveBeenCalledTimes(1),
    );
    const [, payload] = vi.mocked(updateTenantModeSettings).mock.calls[0];
    expect(payload.backupSupervisorUserId).toBeNull();
  });
});
