import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobList } from './JobList';

vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: vi.fn(),
}));

import { useListQuery } from '../../hooks/useListQuery';

describe('JobList', () => {
  beforeEach(() => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [{ id: '1', jobNumber: 'JOB-001', summary: 'Fix leak', status: 'open', priority: 'high', customerId: 'c1' }],
      total: 1, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
  });

  it('renders job list', () => {
    render(<JobList />);
    expect(screen.getByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('JOB-001')).toBeInTheDocument();
    expect(screen.getByText('Fix leak')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [], total: 0, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
    render(<JobList />);
    expect(screen.getByText('No jobs yet')).toBeInTheDocument();
  });
});
