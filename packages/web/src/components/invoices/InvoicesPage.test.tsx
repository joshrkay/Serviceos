import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/invoices', {
      refetchInterval: 30_000,
    });
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

  // ── U4 (E4) — detail amount due/paid from SERVER totals, not a float
  //    line-item recompute. The taxed fixture below has a `totals.totalCents`
  //    that does NOT equal Σ(qty*rate); the page must show totalCents.
  function renderTaxedDetail(over: Record<string, unknown> = {}) {
    const totals = {
      subtotalCents: 100000,
      discountCents: 0,
      taxRateBps: 825,
      taxableSubtotalCents: 100000,
      taxCents: 8250,
      totalCents: 108250, // ≠ Σ(qty*rate) = 100000
    };
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: 'i-tax',
        invoiceNumber: 'INV-TAX',
        status: 'open',
        dueDate: '2099-12-31',
        lineItems: [
          {
            id: 'li-1',
            description: 'Labor',
            quantity: 1,
            unitPriceCents: 100000,
            totalCents: 100000,
            category: 'labor',
            sortOrder: 0,
            taxable: true,
          },
        ],
        totals,
        amountPaidCents: 0,
        amountDueCents: 108250,
        customer: { id: 'c1', displayName: 'Taxed Customer' },
        ...over,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    return render(
      <MemoryRouter>
        <InvoicesPage defaultSelectedId="i-tax" />
      </MemoryRouter>,
    );
  }

  it('U4: shows the server totals.totalCents (tax included), not Σ(qty*rate)', () => {
    renderTaxedDetail();
    // The taxed total ($1,082.50) is shown; the raw line-item subtotal
    // ($1,000.00) must NOT be the headline amount-due.
    expect(screen.getAllByText('$1,082.50').length).toBeGreaterThan(0);
  });

  it('U4: partial payment shows remaining amountDueCents + a Paid line', () => {
    renderTaxedDetail({
      amountPaidCents: 50000, // $500 collected
      amountDueCents: 58250, // $582.50 remaining
    });
    // Headline amount due is the remaining balance, not the full total.
    expect(screen.getAllByText('$582.50').length).toBeGreaterThan(0);
    // Separate "Paid" line surfaces the collected amount of the full total.
    expect(screen.getByText(/Paid \$500\.00 of \$1,082\.50/)).toBeInTheDocument();
  });

  // ── U12 (E14) — Mark-as-paid is gated to payable statuses.
  function renderStatusDetail(status: string, over: Record<string, unknown> = {}) {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: 'i-mp',
        invoiceNumber: 'INV-MP',
        status,
        dueDate: '2099-12-31',
        lineItems: [],
        totals: totalsOf(120000),
        amountPaidCents: 0,
        amountDueCents: 120000,
        customer: { id: 'c1', displayName: 'Mark Paid Customer' },
        ...over,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    return render(
      <MemoryRouter>
        <InvoicesPage defaultSelectedId="i-mp" />
      </MemoryRouter>,
    );
  }

  it('U12: hides "Mark as paid" for a draft invoice', () => {
    renderStatusDetail('draft');
    expect(screen.queryByRole('button', { name: /mark as paid/i })).not.toBeInTheDocument();
  });

  it('U12: shows "Mark as paid" for an open invoice', () => {
    renderStatusDetail('open');
    expect(screen.getByRole('button', { name: /mark as paid/i })).toBeInTheDocument();
  });

  it('U12: shows "Mark as paid" for a partially_paid invoice', () => {
    renderStatusDetail('partially_paid', { amountPaidCents: 50000, amountDueCents: 70000 });
    expect(screen.getByRole('button', { name: /mark as paid/i })).toBeInTheDocument();
  });

  it('U12: hides "Mark as paid" for a paid invoice', () => {
    renderStatusDetail('paid', { amountPaidCents: 120000, amountDueCents: 0 });
    expect(screen.queryByRole('button', { name: /mark as paid/i })).not.toBeInTheDocument();
  });

  it('U12: hides "Mark as paid" for a void invoice', () => {
    renderStatusDetail('void');
    expect(screen.queryByRole('button', { name: /mark as paid/i })).not.toBeInTheDocument();
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

// ── U5 — draft line-item persistence + real Stripe payment link ──────────
describe('U5 InvoicesPage — line-item save PUTs + stripePaymentLinkUrl', () => {
  const draftLine = {
    id: 'li-1',
    description: 'Labor',
    quantity: 1,
    unitPriceCents: 100000,
    totalCents: 100000,
    category: 'labor',
    sortOrder: 0,
    taxable: true,
  };
  const draftInvoice = {
    id: 'i-draft',
    invoiceNumber: 'INV-DRAFT',
    status: 'draft',
    lineItems: [draftLine],
    totals: totalsOf(100000),
    amountPaidCents: 0,
    amountDueCents: 100000,
    customer: { id: 'c1', displayName: 'Draft Customer' },
  };
  const openInvoice = {
    id: 'i-open',
    invoiceNumber: 'INV-OPEN',
    status: 'open',
    dueDate: '2099-12-31',
    lineItems: [draftLine],
    totals: totalsOf(100000),
    amountPaidCents: 0,
    amountDueCents: 100000,
    customer: { id: 'c1', displayName: 'Open Customer' },
  };

  beforeEach(() => {
    // Notes/attachments effects fetch on mount — keep them off the network.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderDetail(id: string) {
    return render(
      <MemoryRouter>
        <InvoicesPage defaultSelectedId={id} />
      </MemoryRouter>,
    );
  }

  it('editor save PUTs { lineItems } to /api/invoices/:id and re-renders server data', async () => {
    const mutateMock = vi.fn().mockResolvedValue({});
    vi.mocked(useMutation).mockReturnValue({ mutate: mutateMock, isLoading: false, error: null });

    // The server's post-save truth differs from the local draft so the test
    // proves the view re-renders REFETCHED data, not locally committed state.
    const updatedInvoice = {
      ...draftInvoice,
      lineItems: [{ ...draftLine, description: 'Labor (server)', unitPriceCents: 150000, totalCents: 150000 }],
      totals: totalsOf(150000),
    };
    const refetch = vi.fn(async () => {
      vi.mocked(useDetailQuery).mockReturnValue({ data: updatedInvoice, isLoading: false, error: null, refetch });
    });
    vi.mocked(useDetailQuery).mockReturnValue({ data: draftInvoice, isLoading: false, error: null, refetch });

    renderDetail('i-draft');

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByDisplayValue('Labor'), { target: { value: 'Labor (edited)' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));
    expect(vi.mocked(useMutation)).toHaveBeenCalledWith('PUT', '/api/invoices/i-draft');
    expect(mutateMock.mock.calls[0][0]).toEqual({
      lineItems: [
        expect.objectContaining({
          id: 'li-1',
          description: 'Labor (edited)',
          quantity: 1,
          unitPriceCents: 100000,
          totalCents: 100000,
          sortOrder: 0,
          taxable: true,
        }),
      ],
    });
    expect(refetch).toHaveBeenCalledTimes(1);

    // Editor closes and the rows shown are the SERVER's refetched ones.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument());
    expect(screen.getByText('Labor (server)')).toBeInTheDocument();
  });

  it('PUT failure keeps the editor open, shows the error, and does not refetch', async () => {
    const mutateMock = vi.fn().mockRejectedValue(Object.assign(new Error('HTTP 500'), { status: 500 }));
    vi.mocked(useMutation).mockReturnValue({ mutate: mutateMock, isLoading: false, error: null });
    const refetch = vi.fn();
    vi.mocked(useDetailQuery).mockReturnValue({ data: draftInvoice, isLoading: false, error: null, refetch });

    renderDetail('i-draft');

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByDisplayValue('Labor'), { target: { value: 'Labor (edited)' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeInTheDocument());
    // Editor is still open with the draft intact — nothing was committed.
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Labor (edited)')).toBeInTheDocument();
    expect(refetch).not.toHaveBeenCalled();
  });

  it('entering edit mode re-seeds the draft from current items (no stale rows)', () => {
    const refetch = vi.fn();
    vi.mocked(useDetailQuery).mockReturnValue({ data: draftInvoice, isLoading: false, error: null, refetch });
    const { rerender } = renderDetail('i-draft');

    // Server data changes between mount and entering edit mode.
    vi.mocked(useDetailQuery).mockReturnValue({
      data: { ...draftInvoice, lineItems: [{ ...draftLine, description: 'Labor v2' }] },
      isLoading: false,
      error: null,
      refetch,
    });
    rerender(
      <MemoryRouter>
        <InvoicesPage defaultSelectedId="i-draft" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.getByDisplayValue('Labor v2')).toBeInTheDocument();
  });

  it('renders and copies the real stripePaymentLinkUrl when present', () => {
    const url = 'https://pay.stripe.com/plink_123';
    vi.mocked(useDetailQuery).mockReturnValue({
      data: { ...openInvoice, stripePaymentLinkUrl: url },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { container } = renderDetail('i-open');

    expect(screen.getByText(url)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /copy link/i }));
    expect(writeText).toHaveBeenCalledWith(url);
    expect(container.innerHTML).not.toContain('pay.rivet.ai');
  });

  it('without stripePaymentLinkUrl there is no copyable link — a hint shows instead', () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: openInvoice,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    const { container } = renderDetail('i-open');

    expect(screen.queryByRole('button', { name: /copy link/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/send the invoice to generate a payment link/i).length).toBeGreaterThan(0);

    // The send sheet must not fabricate a link either.
    fireEvent.click(screen.getByRole('button', { name: /resend payment link/i }));
    expect(screen.getAllByText(/send the invoice to generate a payment link/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /copy link/i })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain('pay.rivet.ai');
  });

  it('surfaces the viewUrl returned by POST /api/invoices/:id/send after sending', async () => {
    const mutateMock = vi.fn().mockResolvedValue({ viewUrl: 'https://app.test/pay/tok123', viewToken: 'tok123' });
    vi.mocked(useMutation).mockReturnValue({ mutate: mutateMock, isLoading: false, error: null });
    vi.mocked(useDetailQuery).mockReturnValue({
      data: openInvoice,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderDetail('i-open');

    fireEvent.click(screen.getByRole('button', { name: /resend payment link/i }));
    // Anchored: the rail's "Resend payment link" also contains this substring.
    fireEvent.click(screen.getByRole('button', { name: /^send payment link$/i }));

    await waitFor(() => expect(screen.getByText('https://app.test/pay/tok123')).toBeInTheDocument());
    expect(mutateMock).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms' }));
  });

  it('QA 2026-07-19: "Send payment link" on a draft invoice issues it first, then sends — no silent no-op', async () => {
    // Root cause: POST /:id/send never transitioned a draft invoice out of
    // 'draft' (see notifications/send-service.ts) and this UI has no
    // separate "Issue" control anywhere, so the ONE button a draft invoice
    // offers used to 202 and leave the invoice permanently un-payable. The
    // sheet now issues (default 30-day term) before sending whenever the
    // invoice is still a draft.
    const issueMutate = vi.fn().mockResolvedValue({ id: 'i-draft', status: 'open' });
    const sendMutate = vi.fn().mockResolvedValue({ viewUrl: 'https://app.test/pay/newtok', viewToken: 'newtok' });
    vi.mocked(useMutation).mockImplementation((_method, path: string) => {
      if (path.endsWith('/issue')) return { mutate: issueMutate, isLoading: false, error: null };
      if (path.endsWith('/send')) return { mutate: sendMutate, isLoading: false, error: null };
      return { mutate: vi.fn(), isLoading: false, error: null };
    });
    const refetch = vi.fn();
    vi.mocked(useDetailQuery).mockReturnValue({ data: draftInvoice, isLoading: false, error: null, refetch });

    renderDetail('i-draft');

    // A draft invoice's outer trigger and the sheet's inner submit button
    // are BOTH labeled "Send payment link" (unlike open/overdue, where the
    // trigger reads "Resend"/"Send reminder") — open via the sole match,
    // then submit via the second (sheet's) match once it renders.
    fireEvent.click(screen.getByRole('button', { name: /^send payment link$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /^send payment link$/i })[1]);

    await waitFor(() => expect(sendMutate).toHaveBeenCalledTimes(1));
    expect(issueMutate).toHaveBeenCalledTimes(1);
    expect(issueMutate).toHaveBeenCalledWith({});
    // Issue completed (awaited) before send was ever attempted.
    expect(issueMutate.mock.invocationCallOrder[0]).toBeLessThan(
      sendMutate.mock.invocationCallOrder[0],
    );
    expect(sendMutate).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms' }));

    await waitFor(() => expect(screen.getByText('https://app.test/pay/newtok')).toBeInTheDocument());
    // The sheet auto-closes ~1.2s after a successful send and refetches so
    // the now-issued status/journey shows without a manual page reload.
    await waitFor(() => expect(refetch).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('does NOT call /issue for a non-draft invoice — only the existing /send path runs', async () => {
    const issueMutate = vi.fn().mockResolvedValue({});
    const sendMutate = vi.fn().mockResolvedValue({ viewUrl: 'https://app.test/pay/tok', viewToken: 'tok' });
    vi.mocked(useMutation).mockImplementation((_method, path: string) => {
      if (path.endsWith('/issue')) return { mutate: issueMutate, isLoading: false, error: null };
      if (path.endsWith('/send')) return { mutate: sendMutate, isLoading: false, error: null };
      return { mutate: vi.fn(), isLoading: false, error: null };
    });
    vi.mocked(useDetailQuery).mockReturnValue({ data: openInvoice, isLoading: false, error: null, refetch: vi.fn() });

    renderDetail('i-open');

    fireEvent.click(screen.getByRole('button', { name: /resend payment link/i }));
    fireEvent.click(screen.getByRole('button', { name: /^send payment link$/i }));

    await waitFor(() => expect(sendMutate).toHaveBeenCalledTimes(1));
    expect(issueMutate).not.toHaveBeenCalled();
  });

  it('surfaces a draft-invoice send rejection (e.g. issue itself fails) without a silent no-op', async () => {
    const issueMutate = vi.fn().mockRejectedValue(new Error('Invalid transition from canceled to open'));
    const sendMutate = vi.fn();
    vi.mocked(useMutation).mockImplementation((_method, path: string) => {
      if (path.endsWith('/issue')) return { mutate: issueMutate, isLoading: false, error: null };
      if (path.endsWith('/send')) return { mutate: sendMutate, isLoading: false, error: null };
      return { mutate: vi.fn(), isLoading: false, error: null };
    });
    vi.mocked(useDetailQuery).mockReturnValue({ data: draftInvoice, isLoading: false, error: null, refetch: vi.fn() });

    renderDetail('i-draft');

    fireEvent.click(screen.getByRole('button', { name: /^send payment link$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /^send payment link$/i })[1]);

    await waitFor(() =>
      expect(screen.getByText(/send failed: invalid transition from canceled to open/i)).toBeInTheDocument(),
    );
    // send was never attempted once issue failed — no message went out for
    // an invoice that still isn't payable.
    expect(sendMutate).not.toHaveBeenCalled();
  });
});
