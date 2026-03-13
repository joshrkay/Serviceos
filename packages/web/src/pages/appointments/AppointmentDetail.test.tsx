import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppointmentDetail } from './AppointmentDetail';

vi.mock('../../hooks/useDetailQuery', () => ({
  useDetailQuery: vi.fn(),
}));

import { useDetailQuery } from '../../hooks/useDetailQuery';

describe('AppointmentDetail', () => {
  beforeEach(() => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: '1', jobId: 'j1', status: 'scheduled',
        scheduledStart: '2026-03-01T09:00:00Z', scheduledEnd: '2026-03-01T11:00:00Z',
        timezone: 'America/New_York', notes: 'Ring doorbell twice',
        assignments: [
          { technicianId: 't1', technicianName: 'John Smith', isPrimary: true },
        ],
      },
      isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it('renders appointment details', () => {
    render(<AppointmentDetail appointmentId="1" />);
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(screen.getByText('Arrival Window')).toBeInTheDocument();
    expect(screen.getByText('Assigned Technicians')).toBeInTheDocument();
  });

  it('renders technician assignment', () => {
    render(<AppointmentDetail appointmentId="1" />);
    expect(screen.getByText('John Smith (Primary)')).toBeInTheDocument();
  });

  it('renders notes section', () => {
    render(<AppointmentDetail appointmentId="1" />);
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText('Ring doorbell twice')).toBeInTheDocument();
  });

  it('shows no arrival window message', () => {
    render(<AppointmentDetail appointmentId="1" />);
    expect(screen.getByText('No arrival window set.')).toBeInTheDocument();
  });

  it('shows loading when no data', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: true, error: null, refetch: vi.fn(),
    });
    render(<AppointmentDetail appointmentId="1" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: null, isLoading: false, error: 'Not found', refetch: vi.fn(),
    });
    render(<AppointmentDetail appointmentId="1" />);
    expect(screen.getByText('Not found')).toBeInTheDocument();
  });
});
