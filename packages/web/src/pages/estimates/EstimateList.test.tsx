import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EstimateList } from './EstimateList';

vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: vi.fn(),
}));

import { useListQuery } from '../../hooks/useListQuery';

describe('EstimateList', () => {
  beforeEach(() => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [{ id: '1', estimateNumber: 'EST-001', status: 'draft', totalCents: 15000, jobId: 'j1' }],
      total: 1, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
  });

  it('renders estimate list', () => {
    render(<EstimateList />);
    expect(screen.getByText('Estimates')).toBeInTheDocument();
    expect(screen.getByText('EST-001')).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [], total: 0, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
    render(<EstimateList />);
    expect(screen.getByText('No estimates yet')).toBeInTheDocument();
  });
});
