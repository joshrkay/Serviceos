import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppointmentList } from './AppointmentList';

vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: vi.fn(),
}));

import { useListQuery } from '../../hooks/useListQuery';

describe('AppointmentList', () => {
  beforeEach(() => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [
        {
          id: '1', jobId: 'j1', status: 'scheduled',
          scheduledStart: '2026-03-01T09:00:00Z', scheduledEnd: '2026-03-01T11:00:00Z',
          technicianName: 'John Smith',
        },
      ],
      total: 1, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
  });

  it('renders appointment list', () => {
    render(<AppointmentList />);
    expect(screen.getByText('Appointments')).toBeInTheDocument();
    expect(screen.getByText('John Smith')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [], total: 0, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
    render(<AppointmentList />);
    expect(screen.getByText('No appointments yet')).toBeInTheDocument();
  });
});
