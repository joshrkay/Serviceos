import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));

import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useListQuery } from '../../hooks/useListQuery';
import { ContractDetailPage } from './ContractDetailPage';

beforeEach(() => {
  vi.mocked(useDetailQuery).mockReturnValue({
    data: {
      id: 'mc-1',
      title: 'Quarterly HVAC Tune-Up',
      status: 'active',
      cadence: 'Quarterly',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(useListQuery).mockReturnValue({
    data: [],
    total: 0,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as any);
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
  });
});
