import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));

import { useDetailQuery } from '../../hooks/useDetailQuery';
import { ContractDetailPage } from './ContractDetailPage';

beforeEach(() => {
  vi.mocked(useDetailQuery).mockReturnValue({
    data: {
      id: 'mc-1',
      name: 'Quarterly HVAC Tune-Up',
      recurrenceRule: 'FREQ=QUARTERLY',
      status: 'active',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
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
    expect(vi.mocked(useDetailQuery)).toHaveBeenCalledWith('/api/agreements', 'mc-1');
  });
});
