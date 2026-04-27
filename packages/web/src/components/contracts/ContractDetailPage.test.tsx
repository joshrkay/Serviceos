import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));

import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useListQuery } from '../../hooks/useListQuery';
import { useMutation } from '../../hooks/useMutation';
import { ContractDetailPage } from './ContractDetailPage';

beforeEach(() => {
  vi.mocked(useDetailQuery).mockReturnValue({
    data: {
      id: 'mc-1',
      title: 'Quarterly HVAC Tune-Up',
      cadence: 'Quarterly',
      status: 'active',
      serviceWindow: 'Weekdays 8a-12p',
      duration: '12 months',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });

  vi.mocked(useListQuery).mockReturnValue({
    data: [{ id: 'j1', jobNumber: 'JOB-100', summary: 'Spring PM', status: 'scheduled', scheduledStart: '2026-04-01' }],
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

  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
});

describe('ContractDetailPage', () => {
  it('renders with route param id', () => {
    render(
      <MemoryRouter initialEntries={['/contracts/mc-1']}>
        <Routes>
          <Route path="/contracts/:id" element={<ContractDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText('Quarterly HVAC Tune-Up')).toBeInTheDocument();
    expect(vi.mocked(useDetailQuery)).toHaveBeenCalledWith('/api/maintenance-contracts', 'mc-1');
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/jobs', {
      filters: { contractId: 'mc-1' },
      enabled: true,
    });
  });
});
