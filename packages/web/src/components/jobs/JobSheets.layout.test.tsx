/**
 * B7.5 (PR review, FINDING B — operator-side follow-up) — the descriptive
 * `unit` reaches the customer on EstimateApprovalPage/InvoicePaymentPage but
 * was never rendered in the job-sheet "Qty: N × $rate" line for
 * `EstimateSheet`/`InvoiceSheet`. The data was already there: both sheets'
 * line items come from the shared `EstimateResponse`/`InvoiceResponse`
 * contracts, whose `lineItems` are `LineItem` (packages/shared/src/contracts
 * /money.ts) — a schema that has carried `unit` since B7.5. No threading was
 * needed; only the render was missing.
 *
 * Unlike EstimatesPage/InvoicesPage, this row has no fixed-width grid track
 * — it's a full-width paragraph inside a `flex-1 min-w-0` column — so there
 * is no column-width budget to protect and no track-arithmetic contract to
 * pin. The unit is appended as plain inline text and wraps with the rest of
 * the sentence.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { EstimateSheet, InvoiceSheet } from './JobSheets';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body });
}

// 'per gal' is the longest value in catalogUnitSchema.
function makeEstimate() {
  return {
    id: 'est-1',
    tenantId: 't1',
    jobId: 'j1',
    estimateNumber: 'EST-1',
    status: 'sent',
    lineItems: [
      { id: 'li1', description: 'Sealant', quantity: 12, unit: 'per gal', unitPriceCents: 4_200, totalCents: 50_400, sortOrder: 0, taxable: true },
      { id: 'li2', description: 'Prep labor', quantity: 3, unitPriceCents: 8_500, totalCents: 25_500, sortOrder: 1, taxable: true },
    ],
    totals: { subtotalCents: 75_900, discountCents: 0, taxRateBps: 0, taxableSubtotalCents: 75_900, taxCents: 0, totalCents: 75_900 },
    version: 1,
    createdBy: 'u1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

function makeInvoice() {
  return {
    id: 'inv-1',
    tenantId: 't1',
    jobId: 'j1',
    invoiceNumber: 'INV-1',
    status: 'open',
    lineItems: [
      { id: 'li1', description: 'Sealant', quantity: 12, unit: 'per gal', unitPriceCents: 4_200, totalCents: 50_400, sortOrder: 0, taxable: true },
      { id: 'li2', description: 'Prep labor', quantity: 3, unitPriceCents: 8_500, totalCents: 25_500, sortOrder: 1, taxable: true },
    ],
    totals: { subtotalCents: 75_900, discountCents: 0, taxRateBps: 0, taxableSubtotalCents: 75_900, taxCents: 0, totalCents: 75_900 },
    amountPaidCents: 0,
    amountDueCents: 75_900,
    createdBy: 'u1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

beforeEach(() => { apiFetchMock.mockReset(); });

describe('EstimateSheet — B7.5 descriptive unit', () => {
  it('renders the unit inline after the quantity, and omits it for a unit-less line', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => [makeEstimate()] });

    render(
      <MemoryRouter>
        <EstimateSheet jobId="j1" onClose={vi.fn()} />
      </MemoryRouter>,
    );

    const unit = await screen.findByTestId('line-item-unit-0');
    expect(unit.textContent).toBe(' per gal');
    // The full sentence reads naturally with the unit inline.
    expect((unit.parentElement as HTMLElement).textContent).toBe('Qty: 12 per gal × $42.00');
    // The second (unit-less) line renders no unit node — legacy shape unchanged.
    expect(screen.queryByTestId('line-item-unit-1')).not.toBeInTheDocument();
    expect(screen.getByText(/Qty: 3 × \$85\.00/)).toBeInTheDocument();
  });

  it('the unit is descriptive: rendered totals are unchanged with and without a unit', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => [makeEstimate()] });
    render(
      <MemoryRouter>
        <EstimateSheet jobId="j1" onClose={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByTestId('line-item-unit-0');
    // $504.00 = 12 × $42.00, identical to what a unit-less line would show.
    expect(screen.getByText('$504.00')).toBeInTheDocument();
    expect(screen.getByText('$255.00')).toBeInTheDocument();
    expect(screen.getByText('$759.00')).toBeInTheDocument(); // document total
  });

  it('a legacy estimate with no units anywhere renders exactly as before', async () => {
    apiFetchMock.mockImplementation(() => jsonOk([{
      ...makeEstimate(),
      lineItems: [
        { id: 'li1', description: 'Diagnostic visit', quantity: 1, unitPriceCents: 15_000, totalCents: 15_000, sortOrder: 0, taxable: true },
      ],
    }]));
    render(
      <MemoryRouter>
        <EstimateSheet jobId="j1" onClose={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByText('Diagnostic visit');
    expect(screen.queryByTestId('line-item-unit-0')).not.toBeInTheDocument();
    expect(screen.getByText('Qty: 1 × $150.00')).toBeInTheDocument();
  });
});

describe('InvoiceSheet — B7.5 descriptive unit', () => {
  it('renders the unit inline after the quantity, and omits it for a unit-less line', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => [makeInvoice()] });

    render(
      <MemoryRouter>
        <InvoiceSheet jobId="j1" customerName="Alice Smith" customerPhone="5125550000" onClose={vi.fn()} />
      </MemoryRouter>,
    );

    const unit = await screen.findByTestId('line-item-unit-0');
    expect(unit.textContent).toBe(' per gal');
    expect((unit.parentElement as HTMLElement).textContent).toBe('Qty: 12 per gal × $42.00');
    expect(screen.queryByTestId('line-item-unit-1')).not.toBeInTheDocument();
    expect(screen.getByText(/Qty: 3 × \$85\.00/)).toBeInTheDocument();
  });

  it('the unit is descriptive: rendered totals are unchanged with and without a unit', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => [makeInvoice()] });
    render(
      <MemoryRouter>
        <InvoiceSheet jobId="j1" customerName="Alice Smith" customerPhone="5125550000" onClose={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByTestId('line-item-unit-0');
    expect(screen.getByText('$504.00')).toBeInTheDocument();
    expect(screen.getByText('$255.00')).toBeInTheDocument();
    expect(screen.getByText('$759.00')).toBeInTheDocument(); // total due
  });

  it('a legacy invoice with no units anywhere renders exactly as before', async () => {
    apiFetchMock.mockImplementation(() => jsonOk([{
      ...makeInvoice(),
      lineItems: [
        { id: 'li1', description: 'Labor', quantity: 2, unitPriceCents: 10_000, totalCents: 20_000, sortOrder: 0, taxable: true },
      ],
      totals: { subtotalCents: 20_000, discountCents: 0, taxRateBps: 0, taxableSubtotalCents: 20_000, taxCents: 0, totalCents: 20_000 },
      amountDueCents: 20_000,
    }]));
    render(
      <MemoryRouter>
        <InvoiceSheet jobId="j1" customerName="Alice Smith" customerPhone="5125550000" onClose={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByText('Labor');
    expect(screen.queryByTestId('line-item-unit-0')).not.toBeInTheDocument();
    expect(screen.getByText('Qty: 2 × $100.00')).toBeInTheDocument();
  });
});
