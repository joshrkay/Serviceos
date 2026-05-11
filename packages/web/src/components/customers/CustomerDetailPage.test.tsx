import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../estimates/NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));

import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { CustomerDetailPage } from './CustomerDetailPage';

beforeEach(() => {
  vi.mocked(useDetailQuery).mockReturnValue({
    data: {
      id: 'c1',
      displayName: 'Test Customer',
      firstName: 'Test',
      lastName: 'Customer',
      primaryPhone: '+15551234567',
      email: 'test@example.com',
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(useListQuery).mockImplementation((endpoint: string) => {
    if (endpoint === '/api/locations') {
      return {
        data: [],
        total: 0,
        page: 1,
        pageSize: 25,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        setPage: vi.fn(),
        setSearch: vi.fn(),
        setFilters: vi.fn(),
      };
    }
    return {
      data: [
        { id: 'mc-1', name: 'Quarterly HVAC', recurrenceRule: 'FREQ=QUARTERLY', status: 'active' },
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
    };
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
      '/api/agreements',
      { filters: { customerId: 'c1' }, enabled: true },
    );
  });
});
