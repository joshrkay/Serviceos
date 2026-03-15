import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { CustomersPage } from './CustomersPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../estimates/NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('../jobs/NewJobFlow', () => ({ NewJobFlow: () => null }));

import { useListQuery } from '../../hooks/useListQuery';
import { useMutation } from '../../hooks/useMutation';

const mockCustomers = [
  {
    id: 'c1',
    displayName: 'Alice Smith',
    firstName: 'Alice',
    lastName: 'Smith',
    primaryPhone: '5125550001',
    email: 'alice@example.com',
    openJobs: 2,
    tags: [],
    locations: [{ id: 'l1', street1: '123 Main St', serviceTypes: ['HVAC'] }],
  },
  {
    id: 'c2',
    displayName: 'Bob Jones',
    firstName: 'Bob',
    lastName: 'Jones',
    primaryPhone: '5125550002',
    email: 'bob@example.com',
    openJobs: 0,
    tags: ['VIP'],
    locations: [{ id: 'l2', street1: '456 Oak Ave', serviceTypes: ['Plumbing'] }],
  },
];

const defaultListResult = {
  data: mockCustomers,
  total: 2,
  page: 1,
  pageSize: 25,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
  setPage: vi.fn(),
  setSearch: vi.fn(),
  setFilters: vi.fn(),
};

beforeEach(() => {
  vi.mocked(useListQuery).mockReturnValue(defaultListResult);
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
});

function renderPage() {
  return render(
    <MemoryRouter>
      <CustomersPage />
    </MemoryRouter>
  );
}

describe('CustomersPage', () => {
  it('renders customer list', () => {
    renderPage();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
  });

  it('shows customer count in header', () => {
    renderPage();
    expect(screen.getByText(/2 customers/)).toBeInTheDocument();
  });

  it('shows VIP badge', () => {
    renderPage();
    expect(screen.getByText('VIP')).toBeInTheDocument();
  });

  it('shows open jobs badge', () => {
    renderPage();
    expect(screen.getByText('2 open')).toBeInTheDocument();
  });

  it('calls setSearch when user types in search input', () => {
    renderPage();
    const input = screen.getByPlaceholderText('Search name, address, phone…');
    fireEvent.change(input, { target: { value: 'alice' } });
    expect(defaultListResult.setSearch).toHaveBeenCalledWith('alice');
  });

  it('shows loading state', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, isLoading: true, data: [] });
    renderPage();
    // loading spinner should be present (no customer names)
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
  });

  it('shows error state with retry button', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, error: 'HTTP 500', data: [] });
    renderPage();
    expect(screen.getByText('Failed to load customers')).toBeInTheDocument();
    const retry = screen.getByText('Retry');
    fireEvent.click(retry);
    expect(defaultListResult.refetch).toHaveBeenCalled();
  });

  it('shows empty state when no customers match', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, data: [], total: 0 });
    renderPage();
    expect(screen.getByText('No customers found')).toBeInTheDocument();
  });

  it('shows Add customer button', () => {
    renderPage();
    expect(screen.getByText('Add customer')).toBeInTheDocument();
  });

  it('uses /api/customers endpoint', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/customers');
  });
});
