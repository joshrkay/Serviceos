/**
 * #1274 (QA 2026-09-16) — a line-item edit the API refuses (negative price,
 * blank description → 400) rendered as if saved: the invalid line and a
 * wrong total stayed on screen with no error, and only a reload showed the
 * truth. A refused save must show the server's reason and keep the last
 * saved lines and total.
 *
 * Seam: the EstimatesPage detail view, driven the way an operator drives it
 * (Edit → change a rate → Save changes), with the PUT mutation refusing.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EstimatesPage } from './EstimatesPage';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../../hooks/useEstimateTerm', () => ({ useEstimateTerm: vi.fn(() => 'Estimate') }));
vi.mock('./NewEstimateFlow', () => ({ NewEstimateFlow: () => null }));
vi.mock('./ConvertToInvoiceSheet', () => ({ ConvertToInvoiceSheet: () => null }));
vi.mock('../shared/CameraCapture', () => ({ CameraCapture: () => null }));

import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';

const SERVER_REASON = 'Invalid request data: lineItems.0.totalCents does not match quantity × unitPriceCents';

function savedEstimate() {
  return {
    id: 'e1',
    estimateNumber: 'EST-001',
    status: 'draft',
    customerMessage: 'Repair',
    createdAt: '2026-06-01T00:00:00.000Z',
    lineItems: [
      { id: 'li-1', description: 'Water heater install', quantity: 1, unitPriceCents: 100_000, totalCents: 100_000, sortOrder: 0, taxable: false },
      { id: 'li-2', description: 'Permit', quantity: 1, unitPriceCents: 17_000, totalCents: 17_000, sortOrder: 1, taxable: false },
    ],
    totals: { subtotalCents: 117_000, discountCents: 0, taxRateBps: 0, taxableSubtotalCents: 0, taxCents: 0, totalCents: 117_000 },
    customer: { id: 'c1', displayName: 'Priya Whitfield', firstName: 'Priya', lastName: 'Whitfield' },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useListQuery).mockReturnValue({
    data: [], total: 0, page: 1, pageSize: 25, isLoading: false, error: null,
    refetch: vi.fn(), setPage: vi.fn(), setSearch: vi.fn(), setFilters: vi.fn(),
  });
  vi.mocked(useDetailQuery).mockReturnValue({ data: savedEstimate(), isLoading: false, error: null, refetch: vi.fn() });
  const refused = Object.assign(new Error(SERVER_REASON), { status: 400 });
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(async () => { throw refused; }), isLoading: false, error: null });
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

describe('#1274 — a refused line-item edit does not render as saved', () => {
  it('shows the server reason and keeps the last saved lines and total', async () => {
    render(
      <MemoryRouter>
        <EstimatesPage defaultSelectedId="e1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const rateInputs = screen.getAllByRole('spinbutton');
    // Row 1's rate is the second number input (qty, rate per row). The edit
    // is locally valid; the server refuses it.
    fireEvent.change(rateInputs[1], { target: { value: '1200' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(SERVER_REASON);
    await waitFor(() => expect(screen.getAllByText('$1,170.00').length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('$1,200')).not.toBeInTheDocument();
    expect(screen.getAllByText('$1,000').length).toBeGreaterThanOrEqual(1);
  });

  // Decision (#1274 "decide whether qty 0 is valid"): no — a $0 line is
  // noise the customer sees; removing the line is how to drop it. The editor
  // says so before anything is sent.
  it('refuses a zero-quantity line before saving, with a reason', async () => {
    const mutate = vi.fn(async () => savedEstimate());
    vi.mocked(useMutation).mockReturnValue({ mutate, isLoading: false, error: null });
    render(
      <MemoryRouter>
        <EstimatesPage defaultSelectedId="e1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/quantity/i);
    expect(mutate.mock.calls.filter(([body]) => 'lineItems' in (body as object))).toHaveLength(0);
  });
});
