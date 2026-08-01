import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { EstimateSheet, InvoiceSheet } from './JobSheets';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body });
}

function makeEstimate() {
  return {
    id: 'est-1',
    tenantId: 't1',
    jobId: 'j1',
    estimateNumber: 'EST-1',
    status: 'sent',
    lineItems: [
      { id: 'li1', description: 'Diagnostic visit', quantity: 1, unitPriceCents: 15000, totalCents: 15000, sortOrder: 0, taxable: true },
    ],
    totals: { subtotalCents: 15000, discountCents: 0, taxRateBps: 0, taxableSubtotalCents: 15000, taxCents: 0, totalCents: 15000 },
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
      { id: 'li1', description: 'Labor', quantity: 2, unitPriceCents: 10000, totalCents: 20000, sortOrder: 0, taxable: true },
    ],
    totals: { subtotalCents: 20000, discountCents: 0, taxRateBps: 0, taxableSubtotalCents: 20000, taxCents: 0, totalCents: 20000 },
    amountPaidCents: 0,
    amountDueCents: 20000,
    createdBy: 'u1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

beforeEach(() => { apiFetchMock.mockReset(); });

describe('EstimateSheet', () => {
  it('fetches the job estimate by jobId and renders its real number, line items, and total', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => [makeEstimate()] });

    render(
      <MemoryRouter>
        <EstimateSheet jobId="j1" onClose={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Estimate EST-1')).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/estimates?jobId=j1');
    expect(screen.getByText('Diagnostic visit')).toBeInTheDocument();
    expect(screen.getAllByText('$150.00').length).toBeGreaterThan(0);
  });

  it('shows an empty state linking to the create flow when the job has no estimate', async () => {
    apiFetchMock.mockImplementation(() => jsonOk([]));
    render(
      <MemoryRouter>
        <EstimateSheet jobId="j1" onClose={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No estimate linked/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create estimate/i })).toBeInTheDocument();
  });
});

describe('InvoiceSheet', () => {
  it('fetches the job invoice by jobId and offers the real send flow (no fake setSent)', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => [makeInvoice()] });

    render(
      <MemoryRouter>
        <InvoiceSheet jobId="j1" customerName="Alice Smith" customerPhone="5125550000" onClose={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Invoice INV-1')).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/invoices?jobId=j1');
    expect(screen.getByText('Labor')).toBeInTheDocument();
    expect(screen.getAllByText('$200.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /send invoice now/i })).toBeInTheDocument();
  });

  it('shows an empty state linking to the create flow when the job has no invoice', async () => {
    apiFetchMock.mockImplementation(() => jsonOk([]));
    render(
      <MemoryRouter>
        <InvoiceSheet jobId="j1" customerName="Alice Smith" customerPhone="5125550000" onClose={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No invoice linked/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create invoice/i })).toBeInTheDocument();
  });
});
