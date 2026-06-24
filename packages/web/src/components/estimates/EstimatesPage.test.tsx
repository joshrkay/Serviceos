import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimatesPage } from './EstimatesPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../../hooks/useEntityLabels', () => ({ useEntityLabels: vi.fn() }));
vi.mock('./NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('./ConvertToInvoiceSheet', () => ({ ConvertToInvoiceSheet: () => null }));
vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: () => <div data-testid="mock-capture-sheet">Capture open</div>,
}));

import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';
import { useEntityLabels, type EntityLabels } from '../../hooks/useEntityLabels';

// The page consumes useEntityLabels().label('estimateTerm'); build a return
// shape yielding the given term so the existing assertions still pin the
// tenant's word flowing into the document + UI.
const labelsReturning = (estimateTerm: string): EntityLabels => ({
  labels: { estimateTerm } as EntityLabels['labels'],
  label: (key) => (key === 'estimateTerm' ? estimateTerm : key),
});

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
  vi.mocked(useEntityLabels).mockReturnValue(labelsReturning('Estimate'));
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
    vi.mocked(useEntityLabels).mockReturnValue(labelsReturning('Quote'));
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
    vi.mocked(useEntityLabels).mockReturnValue(labelsReturning('Bid'));
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
});
