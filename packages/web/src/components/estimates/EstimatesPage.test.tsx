import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimatesPage } from './EstimatesPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('./NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('./ConvertToInvoiceSheet', () => ({ ConvertToInvoiceSheet: () => null }));

import { useListQuery } from '../../hooks/useListQuery';
import { useMutation } from '../../hooks/useMutation';

const mockEstimates = [
  {
    id: 'e1',
    estimateNumber: 'EST-001',
    status: 'sent',
    totalCents: 150000,
    subtotalCents: 150000,
    createdAt: '2026-03-01T00:00:00Z',
    customer: { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith' },
  },
  {
    id: 'e2',
    estimateNumber: 'EST-002',
    status: 'accepted',
    totalCents: 280000,
    subtotalCents: 280000,
    createdAt: '2026-03-02T00:00:00Z',
    customer: { id: 'c2', displayName: 'Bob Jones', firstName: 'Bob', lastName: 'Jones' },
  },
  {
    id: 'e3',
    estimateNumber: 'EST-003',
    status: 'draft',
    totalCents: 50000,
    subtotalCents: 50000,
    createdAt: '2026-03-03T00:00:00Z',
    customer: { id: 'c3', displayName: 'Carol White', firstName: 'Carol', lastName: 'White' },
  },
];

const defaultListResult = {
  data: mockEstimates,
  total: 3,
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
      <EstimatesPage />
    </MemoryRouter>
  );
}

describe('EstimatesPage', () => {
  it('renders estimate list with customer names', () => {
    renderPage();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('Carol White')).toBeInTheDocument();
  });

  it('renders estimate numbers', () => {
    renderPage();
    expect(screen.getByText('EST-001')).toBeInTheDocument();
    expect(screen.getByText('EST-002')).toBeInTheDocument();
  });

  it('formats totalCents as dollars', () => {
    renderPage();
    expect(screen.getByText('$1500.00')).toBeInTheDocument();
    expect(screen.getByText('$2800.00')).toBeInTheDocument();
  });

  it('normalizes API statuses to UI labels', () => {
    renderPage();
    // 'sent' → 'Sent', 'accepted' → 'Approved', 'draft' → 'Draft'
    expect(screen.getAllByText('Sent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Approved').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
  });

  it('shows summary counts', () => {
    renderPage();
    // 1 pending (sent), 1 approved - multiple '1' values appear across stats
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
  });

  it('shows loading state', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, isLoading: true, data: [] });
    renderPage();
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
  });

  it('shows error state with retry', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, error: 'HTTP 500', data: [] });
    renderPage();
    expect(screen.getByText('Failed to load estimates')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(defaultListResult.refetch).toHaveBeenCalled();
  });

  it('tab filter calls setFilters with API status value', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Approved' }));
    expect(defaultListResult.setFilters).toHaveBeenCalledWith({ status: 'accepted' });
  });

  it('All tab clears filters', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(defaultListResult.setFilters).toHaveBeenCalledWith({});
  });

  it('shows empty state when no estimates', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, data: [], total: 0 });
    renderPage();
    expect(screen.getByText('No estimates')).toBeInTheDocument();
  });

  it('uses /api/estimates endpoint', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/estimates');
  });
});
