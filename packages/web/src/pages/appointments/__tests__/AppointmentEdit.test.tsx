import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppointmentEdit } from '../AppointmentEdit';

const _sharedApiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: _sharedApiFetchMock,
}));
vi.mock('../../../lib/apiClient', () => ({
  useApiClient: () => _sharedApiFetchMock,
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
