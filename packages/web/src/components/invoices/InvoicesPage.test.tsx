import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { InvoicesPage } from './InvoicesPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: () => <div data-testid="mock-capture-sheet">Capture open</div>,
}));
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';
import { toast } from 'sonner';

// Money lives under nested `totals` to match the API's serialized Invoice entity
// (the authenticated GET /api/invoices returns invoice.totals.totalCents, not a
// flat top-level totalCents — the prior flat fixtures masked a real rendering bug).
const totalsOf = (totalCents: number) => ({
  subtotalCents: totalCents,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: totalCents,
  taxCents: 0,
  totalCents,
});

const mockInvoices = [
  {
    id: 'i1',
    invoiceNumber: 'INV-001',
    status: 'open',
    totals: totalsOf(120000),
    // Far-future due date so this open invoice reads 'Unpaid', not the derived
    // 'Overdue' (the overdue derivation is exercised by its own test below,
    // which uses Date.now() — a fixed past date would be wall-clock fragile).
    dueDate: '2099-12-31',
    issuedAt: '2026-03-01T00:00:00Z',
    customer: { id: 'c1', displayName: 'Alice Smith' },
  },
  {
    id: 'i2',
    invoiceNumber: 'INV-002',
    status: 'paid',
    totals: totalsOf(85000),
    customer: { id: 'c2', displayName: 'Bob Jones' },
  },
  {
    id: 'i3',
    invoiceNumber: 'INV-003',
    status: 'draft',
    totals: totalsOf(45000),
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
  vi.restoreAllMocks();
  vi.mocked(useListQuery).mockReturnValue(defaultListResult);
  vi.mocked(useDetailQuery).mockReturnValue({ data: null, isLoading: false, error: null, refetch: vi.fn() });
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

  it('formats detail line items with fixed cents (123450 cents → $1,234.50)', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: 'i-detail',
        invoiceNumber: 'INV-999',
        status: 'open',
        dueDate: '2026-04-01',
        lineItems: [
          {
            id: 'li-1',
            description: 'Labor',
            quantity: 1,
            unitPriceCents: 123450,
            totalCents: 123450,
            category: 'labor',
            sortOrder: 0,
            taxable: true,
          },
        ],
        totals: totalsOf(123450),
        amountDueCents: 123450,
        customer: { id: 'c1', displayName: 'Detail Customer' },
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(
      <MemoryRouter>
        <InvoicesPage defaultSelectedId="i-detail" />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('$1,234.50').length).toBeGreaterThan(0);
  });

  it('keeps trailing .00 on round dollar detail totals', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: 'i-round',
        invoiceNumber: 'INV-1000',
        status: 'open',
        lineItems: [
          {
            id: 'li-1',
            description: 'Flat rate',
            quantity: 1,
            unitPriceCents: 120000,
            totalCents: 120000,
            category: 'labor',
            sortOrder: 0,
            taxable: true,
          },
        ],
        totals: totalsOf(120000),
        amountDueCents: 120000,
        customer: { id: 'c1', displayName: 'Round Total Customer' },
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(
      <MemoryRouter>
        <InvoicesPage defaultSelectedId="i-round" />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('$1,200.00').length).toBeGreaterThan(0);
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

  // U9b — derived overdue: an open invoice past its due date surfaces the
  // (previously unreachable) Overdue banner + reminder, via the shared rule.
  function renderDetail(over: Record<string, unknown>) {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: 'i-od',
        invoiceNumber: 'INV-OD',
        status: 'open',
        lineItems: [],
        totals: totalsOf(120000),
        amountDueCents: 120000,
        customer: { id: 'c1', displayName: 'Overdue Customer' },
        ...over,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    return render(
      <MemoryRouter>
        <InvoicesPage defaultSelectedId="i-od" />
      </MemoryRouter>,
    );
  }

  it('derives Overdue for an open invoice past its due date (banner + badge)', () => {
    renderDetail({ status: 'open', dueDate: '2020-01-15' }); // robustly past
    // The (previously unreachable) overdue banner now renders.
    expect(screen.getByText(/Payment was due/i)).toBeInTheDocument();
    expect(screen.getAllByText('Overdue').length).toBeGreaterThan(0);
  });

  it('does NOT mark an open invoice overdue before its due date', () => {
    renderDetail({ status: 'open', dueDate: '2099-12-31' }); // far future
    expect(screen.queryByText(/Payment was due/i)).not.toBeInTheDocument();
    expect(screen.queryAllByText('Overdue')).toHaveLength(0);
  });

  it('renders on Path A tokens — no raw Tailwind palette leaks', () => {
    const { container } = renderPage();
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border|ring|divide)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
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

  it('renders invoice attachments and opens capture from Add photo', async () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: 'i1',
        invoiceNumber: 'INV-001',
        status: 'draft',
        lineItems: [],
        totals: totalsOf(0),
        amountDueCents: 0,
        customer: { id: 'c1', displayName: 'Alice Smith' },
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/attachments')) {
        return new Response(JSON.stringify([{
          id: 'a1',
          fileId: 'f1',
          entityType: 'invoice',
          entityId: 'i1',
          kind: 'photo',
          caption: 'Receipt photo',
          portalVisible: true,
          downloadUrl: 'https://cdn.test/receipt.jpg',
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    render(
      <MemoryRouter>
        <InvoicesPage defaultSelectedId="i1" />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('invoice-attachments-section')).toBeInTheDocument();
    expect(screen.getByText('Receipt photo')).toBeInTheDocument();
    expect(screen.getByText('Visible to customer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add photo/i }));
    await waitFor(() => expect(screen.getByTestId('mock-capture-sheet')).toBeInTheDocument());
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
