import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../estimates/NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));

import { useListQuery } from '../../hooks/useListQuery';
import { CustomerDetailPage } from './CustomerDetailPage';

beforeEach(() => {
  vi.mocked(useListQuery).mockReturnValue({
    data: [
      { id: 'mc-1', title: 'Quarterly HVAC', cadence: 'Quarterly', status: 'active' },
    ],
    total: 1,
    page: 1,
    pageSize: 25,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    setPage: vi.fn(),
    setSearch: vi.fn(),
    setFilters: vi.fn(),
  });
});

describe('CustomerDetailPage', () => {
  it('renders maintenance contracts heading when contract data exists', () => {
    render(
      <MemoryRouter initialEntries={['/customers/c1']}>
        <Routes>
          <Route path="/customers/:id" element={<CustomerDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByText('Maintenance Contracts')).toBeInTheDocument();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith(
      '/api/customers/c1/maintenance-contracts',
      { enabled: true },
    );
  });
});
