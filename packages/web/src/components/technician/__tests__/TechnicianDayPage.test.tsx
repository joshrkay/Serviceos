/**
 * Sweep-2 S5 — TechnicianDayPage must resolve the INTERNAL users.id UUID
 * (what appointment_assignments.technician_id references), never the auth
 * principal id from `me.user_id` (a Clerk sub like `user_2abc…` /
 * `user_demo_owner`, which the dispatch route's UUID guard 400s on). When
 * the account has no technician mapping the page shows its designed empty
 * state instead of "Failed to load appointments".
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MeResponse } from '../../../hooks/useMe';

vi.mock('../../../hooks/useMe', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useMe')>(
    '../../../hooks/useMe',
  );
  return { ...actual, useMe: vi.fn() };
});

// The day view itself is exercised by its own suite; here we only need to
// know which technicianId the page hands it.
vi.mock('../../../pages/technician/TechnicianDayView', () => ({
  TechnicianDayView: ({ technicianId }: { technicianId: string }) => (
    <div data-testid="mock-day-view">{technicianId}</div>
  ),
}));

import { TechnicianDayPage } from '../TechnicianDayPage';
import { useMe } from '../../../hooks/useMe';

const INTERNAL_UUID = '7e0d3f0a-2b1c-4a5d-9e8f-3c6b7a1d2e4f';

function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: 'user_demo_owner',
    internal_user_id: null,
    tenant_id: 'tenant-1',
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

function mockUseMe(me: MeResponse | null, isLoading = false) {
  vi.mocked(useMe).mockReturnValue({
    me,
    isLoading,
    error: null,
    switchMode: vi.fn(),
    refetch: vi.fn(),
  });
}

describe('TechnicianDayPage — technician id mapping (sweep-2 S5)', () => {
  beforeEach(() => {
    window.localStorage.removeItem('serviceos.technicianId');
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.localStorage.removeItem('serviceos.technicianId');
  });

  it('passes internal_user_id (users.id UUID) to the day view, NOT the Clerk sub', () => {
    mockUseMe(makeMe({ internal_user_id: INTERNAL_UUID }));
    render(<TechnicianDayPage />);
    expect(screen.getByTestId('mock-day-view')).toHaveTextContent(INTERNAL_UUID);
    expect(screen.getByTestId('mock-day-view')).not.toHaveTextContent('user_demo_owner');
  });

  it('shows the designed empty state when the principal has no users-row mapping', () => {
    mockUseMe(makeMe({ internal_user_id: null }));
    render(<TechnicianDayPage />);
    expect(
      screen.getByText('No technician profile found for this account.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('mock-day-view')).not.toBeInTheDocument();
  });

  it('never falls back to the non-UUID auth principal id (user_id)', () => {
    // Regression pin: the earlier fix used me.user_id, which is the auth
    // identity — the dispatch route 400s on it for every non-UUID principal.
    mockUseMe(makeMe({ user_id: 'user_demo_owner', internal_user_id: null }));
    render(<TechnicianDayPage />);
    expect(screen.queryByTestId('mock-day-view')).not.toBeInTheDocument();
  });

  it('shows a loading state while /api/me is in flight', () => {
    mockUseMe(null, true);
    render(<TechnicianDayPage />);
    expect(screen.getByText('Loading your day…')).toBeInTheDocument();
  });

  it('localStorage override (QA/dispatcher impersonation) still wins', () => {
    window.localStorage.setItem('serviceos.technicianId', 'override-uuid');
    mockUseMe(makeMe({ internal_user_id: INTERNAL_UUID }));
    render(<TechnicianDayPage />);
    expect(screen.getByTestId('mock-day-view')).toHaveTextContent('override-uuid');
  });
});
