/**
 * #1414 — the "Create invoice" sheet opened from an ACCEPTED, taxed,
 * discounted estimate must quote the amount the invoice will actually bill.
 *
 * The convert route bills the estimate's own discount and tax rate (proven on
 * real Postgres in packages/api/test/integration/convert-taxed-estimate-1414),
 * but the sheet was handed `taxRateBps: 0` and summed `qty × rate`, so it
 * promised "Create invoice for $1,200" for an invoice of $1,082.50.
 *
 * Worked example: one taxable $1,200.00 line, $200.00 discount, 8.25% tax →
 * tax on $1,000.00 = $82.50; total $1,082.50.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimatesPage } from './EstimatesPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../../hooks/useEstimateTerm', () => ({ useEstimateTerm: vi.fn(() => 'Estimate') }));
vi.mock('./NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('../shared/CameraCapture', () => ({ CameraCapture: () => null }));

import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';

function acceptedTaxedEstimate() {
  return {
    id: 'e1',
    jobId: 'job-1',
    estimateNumber: 'EST-014',
    status: 'accepted',
    customerMessage: 'Repipe',
    createdAt: '2026-06-01T00:00:00.000Z',
    lineItems: [
      { id: 'li-1', description: 'Repipe kitchen', quantity: 1, unitPriceCents: 120_000, totalCents: 120_000, sortOrder: 0, taxable: true },
    ],
    totals: {
      subtotalCents: 120_000,
      discountCents: 20_000,
      taxRateBps: 825,
      taxableSubtotalCents: 120_000,
      taxCents: 8_250,
      totalCents: 108_250,
    },
    customer: { id: 'c1', displayName: 'Tess Carry', firstName: 'Tess', lastName: 'Carry' },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useListQuery).mockReturnValue({
    data: [], total: 0, page: 1, pageSize: 25, isLoading: false, error: null,
    refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
  });
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
  vi.mocked(useDetailQuery).mockReturnValue({
    data: acceptedTaxedEstimate(), isLoading: false, error: null, refetch: vi.fn(),
  });
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

describe('#1414 — Create invoice sheet from a taxed estimate', () => {
  it('quotes the taxed, discounted total the invoice will bill ($1,082.50), with discount and tax rows', async () => {
    render(
      <MemoryRouter>
        <EstimatesPage defaultSelectedId="e1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /convert to invoice/i }));

    const cta = await screen.findByRole('button', { name: /create invoice for/i });
    expect(cta).toHaveTextContent('Create invoice for $1,082.50');

    const sheet = cta.closest('[data-testid="convert-to-invoice-sheet"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(within(sheet).getByText('Discount')).toBeInTheDocument();
    expect(within(sheet).getByText('-$200.00')).toBeInTheDocument();
    expect(within(sheet).getByText('Tax (8.25%)')).toBeInTheDocument();
    expect(within(sheet).getByText('$82.50')).toBeInTheDocument();
  });
});
