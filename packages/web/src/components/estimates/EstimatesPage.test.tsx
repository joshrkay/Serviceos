import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimatesPage, getEstimateRetractCopy } from './EstimatesPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../../hooks/useEstimateTerm', () => ({ useEstimateTerm: vi.fn(() => 'Estimate') }));
vi.mock('./NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('./ConvertToInvoiceSheet', () => ({ ConvertToInvoiceSheet: () => null }));
vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: () => <div data-testid="mock-capture-sheet">Capture open</div>,
}));

import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';
import { useEstimateTerm } from '../../hooks/useEstimateTerm';

// Money lives under nested `totals` to match the API's serialized Estimate
// entity (GET /api/estimates returns estimate.totals.totalCents, not a flat
// top-level totalCents — flat fixtures masked a real rendering bug).
const totalsOf = (totalCents: number) => ({
  subtotalCents: totalCents,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: totalCents,
  taxCents: 0,
  totalCents,
});

const mockEstimates = [
  {
    id: 'e1',
    estimateNumber: 'EST-001',
    status: 'sent',
    totals: totalsOf(150000),
    createdAt: '2026-03-01T00:00:00Z',
    customer: { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith' },
  },
  {
    id: 'e2',
    estimateNumber: 'EST-002',
    status: 'accepted',
    totals: totalsOf(280000),
    createdAt: '2026-03-02T00:00:00Z',
    customer: { id: 'c2', displayName: 'Bob Jones', firstName: 'Bob', lastName: 'Jones' },
  },
  {
    id: 'e3',
    estimateNumber: 'EST-003',
    status: 'draft',
    totals: totalsOf(50000),
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
  vi.restoreAllMocks();
  vi.mocked(useListQuery).mockReturnValue(defaultListResult);
  vi.mocked(useDetailQuery).mockReturnValue({ data: null, isLoading: false, error: null, refetch: vi.fn() });
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
  vi.mocked(useEstimateTerm).mockReturnValue('Estimate');
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
    // Names also appear in the customer-filter <option>s, so allow >1 match.
    expect(screen.getAllByText('Alice Smith').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bob Jones').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Carol White').length).toBeGreaterThan(0);
  });

  it('renders estimate numbers', () => {
    renderPage();
    expect(screen.getByText('EST-001')).toBeInTheDocument();
    expect(screen.getByText('EST-002')).toBeInTheDocument();
  });

  it('formats totalCents as dollars (with thousands separator)', () => {
    renderPage();
    expect(screen.getByText('$1,500.00')).toBeInTheDocument();
    expect(screen.getByText('$2,800.00')).toBeInTheDocument();
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

  it('Expired tab filters by the expired API status', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Expired' }));
    expect(defaultListResult.setFilters).toHaveBeenCalledWith({ status: 'expired' });
  });

  it('surfaces an expired estimate with the Expired label (not Draft)', () => {
    vi.mocked(useListQuery).mockReturnValue({
      ...defaultListResult,
      data: [
        {
          id: 'e9', estimateNumber: 'EST-009', status: 'expired',
          totals: totalsOf(99000), createdAt: '2026-03-09T00:00:00Z',
          customer: { id: 'c9', displayName: 'Dana Lee', firstName: 'Dana', lastName: 'Lee' },
        },
      ],
      total: 1,
    });
    renderPage();
    expect(screen.getAllByText('Expired').length).toBeGreaterThan(0);
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

  it('renders the tenant terminology label (Quote) instead of the canonical noun', () => {
    // 7.4 — tenant's word (Quote/Bid/Estimate) flows into the document & UI.
    vi.mocked(useEstimateTerm).mockReturnValue('Quote');
    renderPage();
    expect(screen.getByRole('heading', { name: 'Quotes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New quote/i })).toBeInTheDocument();
  });

  it('filters the list by customer (7.10)', () => {
    renderPage();
    // Assert on estimate numbers (unique to list rows; not in the dropdown).
    expect(screen.getByText('EST-001')).toBeInTheDocument(); // Alice
    expect(screen.getByText('EST-002')).toBeInTheDocument(); // Bob
    expect(screen.getByText('EST-003')).toBeInTheDocument(); // Carol
    // Select Bob (c2) → only his estimate row remains.
    fireEvent.change(screen.getByLabelText('Filter by customer'), { target: { value: 'c2' } });
    expect(screen.getByText('EST-002')).toBeInTheDocument();
    expect(screen.queryByText('EST-001')).not.toBeInTheDocument();
    expect(screen.queryByText('EST-003')).not.toBeInTheDocument();
  });

  it('uses the tenant label in the empty state', () => {
    vi.mocked(useEstimateTerm).mockReturnValue('Bid');
    vi.mocked(useListQuery).mockReturnValue({ ...defaultListResult, data: [], total: 0 });
    renderPage();
    expect(screen.getByText('No bids')).toBeInTheDocument();
  });

  it('uses /api/estimates endpoint', () => {
    renderPage();
    expect(vi.mocked(useListQuery)).toHaveBeenCalledWith('/api/estimates');
  });

  it('renders estimate attachments and opens capture from Add photo', async () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        id: 'e1',
        estimateNumber: 'EST-001',
        status: 'draft',
        customerMessage: 'Repair',
        createdAt: '2026-06-01T00:00:00.000Z',
        validUntil: '2026-07-01',
        lineItems: [],
        totals: totalsOf(0),
        customer: { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith' },
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
          entityType: 'estimate',
          entityId: 'e1',
          kind: 'photo',
          caption: 'Scope photo',
          downloadUrl: 'https://cdn.test/scope.jpg',
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    render(
      <MemoryRouter>
        <EstimatesPage defaultSelectedId="e1" />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('estimate-attachments-section')).toBeInTheDocument();
    expect(screen.getByText('Scope photo')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add photo/i }));
    await waitFor(() => expect(screen.getByTestId('mock-capture-sheet')).toBeInTheDocument());
  });

  it('LineItemsEditor: entering Edit re-seeds from the latest items so saving keeps refetched rows', async () => {
    const lineA = {
      id: 'li-1', description: 'Original line', quantity: 1,
      unitPriceCents: 10000, totalCents: 10000, sortOrder: 0, taxable: false,
    };
    const lineB = {
      id: 'li-2', description: 'Newer line', quantity: 2,
      unitPriceCents: 5000, totalCents: 10000, sortOrder: 1, taxable: false,
    };
    const estOf = (lineItems: unknown[]) => ({
      id: 'e1',
      estimateNumber: 'EST-001',
      status: 'draft', // editable
      customerMessage: 'Repair',
      createdAt: '2026-06-01T00:00:00.000Z',
      lineItems,
      totals: totalsOf(10000),
      customer: { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith' },
    });
    const updateMutate = vi.fn().mockResolvedValue({});
    vi.mocked(useMutation).mockReturnValue({ mutate: updateMutate, isLoading: false, error: null });
    vi.mocked(useDetailQuery).mockReturnValue({ data: estOf([lineA]), isLoading: false, error: null, refetch: vi.fn() });
    // Detail-view side fetches (notes, history, attachments) are best-effort.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const view = render(
      <MemoryRouter>
        <EstimatesPage defaultSelectedId="e1" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Original line')).toBeInTheDocument();

    // Simulate a refetch landing a newer row after the editor mounted.
    vi.mocked(useDetailQuery).mockReturnValue({ data: estOf([lineA, lineB]), isLoading: false, error: null, refetch: vi.fn() });
    view.rerender(
      <MemoryRouter>
        <EstimatesPage defaultSelectedId="e1" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Newer line')).toBeInTheDocument();

    // Entering Edit must show BOTH rows — the draft re-seeds from the
    // current items, not the mount-time snapshot.
    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    expect(screen.getByDisplayValue('Original line')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Newer line')).toBeInTheDocument();

    // Saving emits the fresh rows — the newer line is not silently deleted.
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(updateMutate).toHaveBeenCalled());
    const body = updateMutate.mock.calls[0][0] as { lineItems: Array<{ description: string; unitPriceCents: number }> };
    expect(body.lineItems).toHaveLength(2);
    expect(body.lineItems.map(li => li.description)).toEqual(['Original line', 'Newer line']);
    expect(body.lineItems[1].unitPriceCents).toBe(5000);
  });

  // U8a — Path A class contract: the list renders on brand tokens only (the
  // hint styles collapse to the semantic tones), no raw Tailwind palette leaks.
  it('renders on Path A tokens — no raw Tailwind palette leaks', () => {
    const { container } = renderPage();
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border|ring|divide)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });
});

describe('getEstimateRetractCopy (D-020 soft-delete withdraw)', () => {
  it('labels sent estimates Withdraw and names the approval-link effect', () => {
    const copy = getEstimateRetractCopy('sent');
    expect(copy.label).toBe('Withdraw');
    expect(copy.isWithdraw).toBe(true);
    expect(copy.confirm).toMatch(/approval link will stop working/i);
    expect(copy.confirm).toMatch(/removed from your list/i);
  });

  it('labels draft estimates Delete with list-removal copy', () => {
    const copy = getEstimateRetractCopy('draft');
    expect(copy.label).toBe('Delete');
    expect(copy.isWithdraw).toBe(false);
    expect(copy.confirm).toMatch(/^Delete this estimate\?/i);
    expect(copy.confirm).not.toMatch(/approval link/i);
  });

  it('keeps Delete for ready_for_review, rejected, and expired', () => {
    for (const status of ['ready_for_review', 'rejected', 'expired'] as const) {
      expect(getEstimateRetractCopy(status).label).toBe('Delete');
      expect(getEstimateRetractCopy(status).isWithdraw).toBe(false);
    }
  });

  it('uses the tenant estimate term in confirm copy', () => {
    expect(getEstimateRetractCopy('sent', 'Quote').confirm).toMatch(/Withdraw this quote\?/i);
    expect(getEstimateRetractCopy('draft', 'Bid').confirm).toMatch(/Delete this bid\?/i);
  });
});

describe('EstimatesPage retract controls (D-020)', () => {
  function detailFixture(status: string) {
    return {
      id: 'e1',
      estimateNumber: 'EST-001',
      status,
      customerMessage: 'Repair',
      createdAt: '2026-06-01T00:00:00.000Z',
      validUntil: '2026-07-01',
      lineItems: [],
      totals: totalsOf(150000),
      customer: { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith' },
    };
  }

  function renderDetail(status: string) {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: detailFixture(status),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    return render(
      <MemoryRouter>
        <EstimatesPage defaultSelectedId="e1" />
      </MemoryRouter>,
    );
  }

  it('shows Withdraw on a sent estimate and confirms with approval-link copy', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderDetail('sent');
    const withdrawBtn = await screen.findByRole('button', { name: /Withdraw/i });
    expect(withdrawBtn).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Withdraw to retract the customer approval link/i)).toBeInTheDocument();
    fireEvent.click(withdrawBtn);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/approval link will stop working/i));
  });

  it('shows Delete on a draft estimate', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderDetail('draft');
    const deleteBtn = await screen.findByRole('button', { name: /^Delete$/i });
    fireEvent.click(deleteBtn);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/^Delete this estimate\?/i));
  });

  it('hides Delete/Withdraw when the estimate is accepted', async () => {
    renderDetail('accepted');
    expect(await screen.findByRole('button', { name: /Convert to invoice/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Withdraw/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete$/i })).not.toBeInTheDocument();
  });

  it('calls DELETE when Withdraw is confirmed on a sent estimate', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/estimates/e1' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(useDetailQuery).mockReturnValue({
      data: detailFixture('sent'),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <EstimatesPage defaultSelectedId="e1" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Withdraw/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/estimates/e1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });
});
