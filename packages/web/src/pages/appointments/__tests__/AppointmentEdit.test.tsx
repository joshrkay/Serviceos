import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppointmentEdit } from '../AppointmentEdit';
import { TenantTimezoneProvider } from '../../../hooks/useTenantTimezone';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

const baseAppt = {
  id: 'a-1',
  jobId: 'j-1',
  status: 'scheduled',
  scheduledStart: '2026-06-01T15:00:00Z',
  scheduledEnd: '2026-06-01T16:00:00Z',
  assignedUserId: 'u-1',
};

describe('P11-007 AppointmentEdit', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('loads the appointment and shows action buttons', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => baseAppt,
    } as unknown as Response);

    render(<AppointmentEdit appointmentId="a-1" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /reschedule/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /reassign/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel appointment/i })).toBeInTheDocument();
  });

  it('opens the Reschedule dialog when Reschedule is clicked', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => baseAppt,
    } as unknown as Response);

    render(<AppointmentEdit appointmentId="a-1" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /reschedule/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /reschedule/i }));
    expect(screen.getByTestId('reschedule-dialog')).toBeInTheDocument();
  });

  it('opens the Cancel dialog when Cancel appointment is clicked', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => baseAppt,
    } as unknown as Response);

    render(<AppointmentEdit appointmentId="a-1" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel appointment/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /cancel appointment/i }));
    expect(screen.getByTestId('cancel-dialog')).toBeInTheDocument();
  });

  it('opens the Reassign dialog when Reassign is clicked', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseAppt,
      } as unknown as Response)
      // ReassignDialog will fetch users when mounted.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as unknown as Response);

    render(<AppointmentEdit appointmentId="a-1" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /reassign/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /reassign/i }));
    expect(screen.getByTestId('reassign-dialog')).toBeInTheDocument();
  });

  // BUG A regression — the start/end were rendered with
  // `new Date(iso).toLocaleString()` (browser-local tz), so the same instant
  // showed a different time (and often a different DAY) for every viewer.
  // They must render in the TENANT timezone, deterministically, regardless of
  // the JS runtime timezone (CLAUDE.md: "stored UTC, rendered in tenant tz").
  it('renders start/end in the tenant timezone, not browser-local', async () => {
    // 03:30 UTC is the day BEFORE, 8:30 PM, in Phoenix (UTC-7, no DST).
    const appt = {
      ...baseAppt,
      scheduledStart: '2026-06-01T03:30:00Z',
      scheduledEnd: '2026-06-01T05:00:00Z',
    };
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => appt,
    } as unknown as Response);

    render(
      <TenantTimezoneProvider overrideTimezone="America/Phoenix">
        <AppointmentEdit appointmentId="a-1" />
      </TenantTimezoneProvider>,
    );

    // Phoenix wall clock: May 31, 2026, 8:30 PM — NOT the browser-local render.
    expect(await screen.findByText(/Start:\s*May 31, 2026, 8:30\s*PM/)).toBeInTheDocument();
    expect(screen.getByText(/End:\s*May 31, 2026, 10:00\s*PM/)).toBeInTheDocument();
  });

  it('renders the same instant differently under a different tenant tz', async () => {
    const appt = {
      ...baseAppt,
      scheduledStart: '2026-06-01T03:30:00Z',
      scheduledEnd: '2026-06-01T05:00:00Z',
    };
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => appt,
    } as unknown as Response);

    render(
      <TenantTimezoneProvider overrideTimezone="Australia/Sydney">
        <AppointmentEdit appointmentId="a-1" />
      </TenantTimezoneProvider>,
    );

    // Sydney (UTC+10) renders the same instant as Jun 1, 1:30 PM.
    expect(await screen.findByText(/Start:\s*Jun 1, 2026, 1:30\s*PM/)).toBeInTheDocument();
  });

  it('shows error state when load fails', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);

    render(<AppointmentEdit appointmentId="a-1" />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
