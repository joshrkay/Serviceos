import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentList } from './PaymentList';

vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: vi.fn(),
}));

import { useListQuery } from '../../hooks/useListQuery';

describe('PaymentList', () => {
  beforeEach(() => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [
        { id: '1', invoiceId: 'inv-1', amountCents: 15000, method: 'credit_card', status: 'completed', createdAt: '2026-01-20T00:00:00Z' },
      ],
      total: 1, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
  });

  it('renders payment list', () => {
    render(<PaymentList />);
    expect(screen.getByText('Payments')).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('credit_card')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [], total: 0, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
    render(<PaymentList />);
    expect(screen.getByText('No payments yet')).toBeInTheDocument();
  });
});
