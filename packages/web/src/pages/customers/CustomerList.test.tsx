import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerList } from './CustomerList';

vi.mock('../../hooks/useListQuery', () => ({
  useListQuery: vi.fn(),
}));

import { useListQuery } from '../../hooks/useListQuery';

describe('CustomerList', () => {
  beforeEach(() => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [
        { id: '1', displayName: 'Alice', companyName: 'Acme', email: 'alice@test.com', primaryPhone: '555-0100', isArchived: false },
        { id: '2', displayName: 'Bob', companyName: undefined, email: undefined, primaryPhone: undefined, isArchived: false },
      ],
      total: 2,
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

  it('renders customer list with data', () => {
    render(<CustomerList />);
    expect(screen.getByText('Customers')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [], total: 0, page: 1, pageSize: 25, isLoading: true, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
    render(<CustomerList />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    vi.mocked(useListQuery).mockReturnValue({
      data: [], total: 0, page: 1, pageSize: 25, isLoading: false, error: null,
      refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
    });
    render(<CustomerList />);
    expect(screen.getByText('No customers yet')).toBeInTheDocument();
  });
});
