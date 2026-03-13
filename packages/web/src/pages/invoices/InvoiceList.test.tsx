import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InvoiceList } from './InvoiceList';

vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: vi.fn(),
}));

import { useListQuery } from '../../hooks/useListQuery';

describe('InvoiceList', () => {
  beforeEach(() => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [{ id: '1', invoiceNumber: 'INV-001', status: 'sent', totalCents: 20000, amountDueCents: 20000, dueDate: '2026-04-01' }],
      total: 1, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
  });

  it('renders invoice list', () => {
    render(<InvoiceList />);
    expect(screen.getByText('Invoices')).toBeInTheDocument();
    expect(screen.getByText('INV-001')).toBeInTheDocument();
    expect(screen.getAllByText('$200.00')).toHaveLength(2);
  });

  it('shows empty state', () => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [], total: 0, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
    render(<InvoiceList />);
    expect(screen.getByText('No invoices yet')).toBeInTheDocument();
  });
});
