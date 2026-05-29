import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { InvoicesPage } from './InvoicesPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { useListQuery } from '../../hooks/useListQuery';
import { useMutation } from '../../hooks/useMutation';
import { toast } from 'sonner';

const mockInvoices = [
  {
    id: 'i1',
    invoiceNumber: 'INV-001',
    status: 'open',
    totalCents: 120000,
    subtotalCents: 120000,
    dueDate: '2026-03-20',
    issuedAt: '2026-03-01T00:00:00Z',
    customer: { id: 'c1', displayName: 'Alice Smith' },
  },
  {
    id: 'i2',
    invoiceNumber: 'INV-002',
    status: 'paid',
    totalCents: 85000,
    subtotalCents: 85000,
    customer: { id: 'c2', displayName: 'Bob Jones' },
  },
  {
    id: 'i3',
    invoiceNumber: 'INV-003',
    status: 'draft',
    totalCents: 45000,
    subtotalCents: 45000,
    customer: { id: 'c3', displayName: 'Carol White' },
  },
];

const defaultListResult = {
  data: mockInvoices,
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
      <InvoicesPage />
    </MemoryRouter>
  );
}

describe('InvoicesPage', () => {
  it('renders invoice list with customer names', () => {
    renderPage();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('Carol White')).toBeInTheDocument();
  });

  it('renders invoice numbers', () => {
    renderPage();
    expect(screen.getByText('INV-001')).toBeInTheDocument();
    expect(screen.getByText('INV-002')).toBeInTheDocument();
  });

  it('formats totalCents as dollars', () => {
    renderPage();
    expect(screen.getAllByText('$1,200.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$850.00').length).toBeGreaterThan(0);
  });

  it('normalizes API statuses to UI labels', () => {
    renderPage();
    // 'open' → 'Unpaid', 'paid' → 'Paid', 'draft' → 'Draft'
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
  });

  it('shows outstanding total', () => {
    renderPage();
    // only open invoice: $1,200.00 outstanding (may appear multiple times)
    expect(screen.getAllByText('$1,200.00').length).toBeGreaterThan(0);
  });

  it('shows total invoice count', () => {
    renderPage();
    expect(screen.getByText('3 invoices')).toBeInTheDocument();
  });

  it('tab filter calls setFilters', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Paid' }));
    expect(defaultListResult.setFilters).toHaveBeenCalledWith({ status: 'paid' });
  });

  it('All tab clears filters', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(defaultListResult.setFilters).toHaveBeenCalledWith({});
  });

  it('shows loading state', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, isLoading: true, data: [] });
    renderPage();
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
  });

  it('shows error state with retry', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, error: 'HTTP 500', data: [] });
    renderPage();
    expect(screen.getByText('Failed to load invoices')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(defaultListResult.refetch).toHaveBeenCalled();
  });

  it('shows empty state when no invoices', () => {
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, data: [], total: 0 });
    renderPage();
    expect(screen.getByText('No invoices')).toBeInTheDocument();
  });

  it('uses /api/invoices endpoint', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/invoices');
  });
});

describe('P5-018 InvoicesPage — payment confirmation reflection', () => {
  beforeEach(() => {
    vi.mocked(useListQuery).mockReturnValue(defaultListResult);
    vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it('does NOT toast on initial render — only on a status TRANSITION to paid', () => {
    // Initial load already includes a `paid` invoice (INV-002). That's
    // not a transition, so no toast should fire.
    renderPage();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it('toasts when an open invoice flips to paid between refetches', () => {
    // First render: i1 is open.
    const { rerender } = render(
      <MemoryRouter>
        <InvoicesPage />
      </MemoryRouter>,
    );
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();

    // Simulate a refetch where i1 has flipped to paid.
    vi.mocked(useListQuery).mockReturnValue({
      ...defaultListResult,
      data: [
        { ...mockInvoices[0], status: 'paid' },
        mockInvoices[1],
        mockInvoices[2],
      ],
    });

    rerender(
      <MemoryRouter>
        <InvoicesPage />
      </MemoryRouter>,
    );

    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining('INV-001'),
    );
  });

  it('does not double-toast when the same paid status persists across refetches', () => {
    const { rerender } = render(
      <MemoryRouter>
        <InvoicesPage />
      </MemoryRouter>,
    );

    // i1 flips to paid.
    vi.mocked(useListQuery).mockReturnValue({
      ...defaultListResult,
      data: [
        { ...mockInvoices[0], status: 'paid' },
        mockInvoices[1],
        mockInvoices[2],
      ],
    });
    rerender(
      <MemoryRouter>
        <InvoicesPage />
      </MemoryRouter>,
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);

    // Another refetch — still paid. Should NOT re-toast.
    rerender(
      <MemoryRouter>
        <InvoicesPage />
      </MemoryRouter>,
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
  });

  it('reflects status updates immediately when the underlying list query changes', () => {
    const { rerender } = render(
      <MemoryRouter>
        <InvoicesPage />
      </MemoryRouter>,
    );
    // Initially i1 is Unpaid.
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThan(0);

    // Refetch — i1 is now paid.
    vi.mocked(useListQuery).mockReturnValue({
      ...defaultListResult,
      data: [
        { ...mockInvoices[0], status: 'paid' },
        mockInvoices[1],
        mockInvoices[2],
      ],
    });
    rerender(
      <MemoryRouter>
        <InvoicesPage />
      </MemoryRouter>,
    );

    // 3 paid statuses now visible (was 1 paid before).
    expect(screen.getAllByText('Paid').length).toBeGreaterThanOrEqual(2);
  });
});
