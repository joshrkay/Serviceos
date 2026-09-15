/**
 * D-7 (docs/verification/full-verification-2026-09-06.md) — runtime proof:
 * an estimate with three taxable lines (12900 + 3×4500 + 8900 = 35300 cents)
 * and taxRateBps 800 is stored by the API with totalCents 38124, but the
 * detail view rendered "$353" (the untaxed subtotal) in the header badge,
 * the line-items table's "Total" row, and the "Estimate total" card — no
 * Tax row anywhere. This pins the fix: the detail view must show the taxed
 * total (and a Tax row) from `est.totals`, never the bare line-item sum.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimatesPage } from './EstimatesPage';

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

// Runtime-proven fixture from the defect report: three taxable lines summing
// to 35300 cents, 8% tax -> 2824 cents tax, 38124 cents total.
const taxedLineItems = [
  { id: 'li-1', description: 'Part A', quantity: 1, unitPriceCents: 12_900, totalCents: 12_900, sortOrder: 0, taxable: true },
  { id: 'li-2', description: 'Part B', quantity: 3, unitPriceCents: 4_500, totalCents: 13_500, sortOrder: 1, taxable: true },
  { id: 'li-3', description: 'Labor', quantity: 1, unitPriceCents: 8_900, totalCents: 8_900, sortOrder: 2, taxable: true },
];

const taxedTotals = {
  subtotalCents: 35_300,
  discountCents: 0,
  taxRateBps: 800,
  taxableSubtotalCents: 35_300,
  taxCents: 2_824,
  totalCents: 38_124,
};

function taxedEstimate() {
  return {
    id: 'e1',
    estimateNumber: 'EST-001',
    status: 'draft',
    customerMessage: 'Repair',
    createdAt: '2026-06-01T00:00:00.000Z',
    lineItems: taxedLineItems,
    totals: taxedTotals,
    customer: { id: 'c1', displayName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith' },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useListQuery).mockReturnValue({
    data: [], total: 0, page: 1, pageSize: 25, isLoading: false, error: null,
    refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
  });
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
  vi.mocked(useEstimateTerm).mockReturnValue('Estimate');
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

function renderDetail() {
  vi.mocked(useDetailQuery).mockReturnValue({
    data: taxedEstimate(), isLoading: false, error: null, refetch: vi.fn(),
  });
  return render(
    <MemoryRouter>
      <EstimatesPage defaultSelectedId="e1" />
    </MemoryRouter>,
  );
}

describe('EstimatesPage detail view — taxed totals (D-7)', () => {
  it('shows the taxed total, not the untaxed subtotal, and renders a Tax row', async () => {
    renderDetail();

    // The taxed total ($381.24) must appear (header badge + "Estimate
    // total" card both render the same string).
    const taxedTotalMatches = await screen.findAllByText('$381.24');
    expect(taxedTotalMatches.length).toBeGreaterThanOrEqual(2);

    // The untaxed subtotal ($353.00) may appear exactly once — correctly
    // labeled "Subtotal" in the line-items table footer — but must never
    // stand in for the total anywhere. This is the exact bug: `total` was
    // `uiLineItems.reduce((s,i) => s + i.qty*i.rate, 0)`, ignoring tax
    // entirely, and rendered in the header badge, the "Total" row, AND the
    // "Estimate total" card.
    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getAllByText('$353.00')).toHaveLength(1);

    // A Tax row, labeled with the rate, must be present.
    expect(screen.getByText('Tax (8.00%)')).toBeInTheDocument();
    expect(screen.getByText('$28.24')).toBeInTheDocument();
  });

  it('does not render a Tax row or Discount row when there is no tax/discount', async () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: {
        ...taxedEstimate(),
        lineItems: taxedLineItems.map(l => ({ ...l, taxable: false })),
        totals: {
          subtotalCents: 35_300,
          discountCents: 0,
          taxRateBps: 0,
          taxableSubtotalCents: 0,
          taxCents: 0,
          totalCents: 35_300,
        },
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <EstimatesPage defaultSelectedId="e1" />
      </MemoryRouter>,
    );

    expect((await screen.findAllByText('$353.00')).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/^Tax \(/)).not.toBeInTheDocument();
    expect(screen.queryByText('Discount')).not.toBeInTheDocument();
  });
});
