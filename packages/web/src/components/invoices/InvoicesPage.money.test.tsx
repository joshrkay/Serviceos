/**
 * #1400 (QA 2026-09-26 §5) — invoice detail money is the API's. Fixtures are
 * parsed through the shared invoiceResponseSchema (GET /api/invoices/:id).
 * INV-0026 from the sweep: subtotal $91.30, −$5.00 discount, 8.25% tax
 * $7.12, total $93.42 — the line-items footer showed "Total due $91.30"
 * because it re-summed qty × rate and ignored discount and tax.
 */
import React from 'react';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { InvoicesPage } from './InvoicesPage';
import { listQueryResult } from '../../test-utils/list-query-result';
import { apiInvoice } from '../../test-utils/money-fixtures';

vi.mock('../../hooks/useListQuery', () => ({ useListQuery: vi.fn() }));
vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../hooks/useMutation', () => ({ useMutation: vi.fn() }));
vi.mock('../../hooks/useTenantTimezone', () => ({ useTenantTimezone: vi.fn(() => 'UTC') }));
vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useListQuery } from '../../hooks/useListQuery';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useMutation } from '../../hooks/useMutation';
import { apiFetch } from '../../utils/api-fetch';

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

let apiRoutes: Record<string, unknown> = {};

beforeEach(() => {
  vi.restoreAllMocks();
  apiRoutes = {};
  vi.mocked(useListQuery).mockReturnValue(listQueryResult([]));
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
  vi.mocked(apiFetch).mockImplementation(async (url: RequestInfo | URL) => {
    const path = String(url);
    const hit = Object.keys(apiRoutes).find((p) => path.startsWith(p));
    return json(hit ? apiRoutes[hit] : []);
  });
});

function renderDetail(invoice: ReturnType<typeof apiInvoice>) {
  vi.mocked(useDetailQuery).mockReturnValue({ data: invoice, isLoading: false, error: null, refetch: vi.fn() });
  return render(
    <MemoryRouter initialEntries={[`/invoices/${invoice.id}`]}>
      <InvoicesPage defaultSelectedId={invoice.id} />
    </MemoryRouter>,
  );
}

describe('InvoicesPage detail money (#1400)', () => {
  it('the line-items footer shows the API discount, tax and total due — not the untaxed line sum', () => {
    renderDetail(apiInvoice({ customer: { id: 'c1', displayName: 'Bob Jones' } }));
    const footer = screen.getByText('Total due').parentElement!.parentElement!;
    expect(within(footer).getByText('-$5.00')).toBeInTheDocument();
    expect(within(footer).getByText('Tax (8.25%)')).toBeInTheDocument();
    expect(within(footer).getByText('$7.12')).toBeInTheDocument();
    expect(screen.getByText('Total due').nextElementSibling?.textContent).toBe('$93.42');
  });

  it('lists each payment (date, method, amount) instead of only the aggregate', async () => {
    const inv = apiInvoice({
      status: 'partially_paid',
      totals: { subtotalCents: 50000, taxableSubtotalCents: 50000, discountCents: 0, taxRateBps: 0, taxCents: 0, totalCents: 50000 },
      amountPaidCents: 30000,
      amountDueCents: 20000,
    });
    // GET /api/payments?invoiceId= row shape (routes/payments.ts → Payment), newest first.
    apiRoutes['/api/payments?invoiceId='] = [
      { id: 'p2', invoiceId: inv.id, amountCents: 20000, method: 'check', status: 'completed', receivedAt: '2026-09-25T15:00:00.000Z', refundedAmountCents: 0 },
      { id: 'p1', invoiceId: inv.id, amountCents: 10000, method: 'cash', status: 'completed', receivedAt: '2026-09-20T15:00:00.000Z', refundedAmountCents: 0 },
    ];
    renderDetail(inv);

    const history = await screen.findByRole('region', { name: 'Payment history' });
    const rows = within(history).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Sep 25');
    expect(rows[0].textContent).toContain('Check');
    expect(rows[0].textContent).toContain('$200.00');
    expect(rows[1].textContent).toContain('Sep 20');
    expect(rows[1].textContent).toContain('Cash');
    expect(rows[1].textContent).toContain('$100.00');
  });

  it('Download receipt prints a receipt with the API total and each payment (the button had no handler)', async () => {
    const inv = apiInvoice({ invoiceNumber: 'INV-0031', status: 'paid', amountPaidCents: 9342, amountDueCents: 0 });
    apiRoutes['/api/payments?invoiceId='] = [
      { id: 'p1', invoiceId: inv.id, amountCents: 9342, method: 'cash', status: 'completed', receivedAt: '2026-09-26T15:00:00.000Z', refundedAmountCents: 0 },
    ];
    apiRoutes['/api/settings'] = { businessName: 'Acme HVAC' };
    const written: string[] = [];
    vi.spyOn(window, 'open').mockReturnValue({
      document: { write: (html: string) => written.push(html), close: () => {} },
    } as unknown as Window);
    renderDetail(inv);
    await screen.findByRole('region', { name: 'Payment history' });

    fireEvent.click(screen.getByRole('button', { name: /Download receipt/ }));

    await waitFor(() => expect(written.join('')).toContain('INV-0031'));
    const html = written.join('');
    expect(html).toContain('Receipt');
    expect(html).toContain('Acme HVAC');
    expect(html).toMatch(/<span>Total<\/span>\s*<span>\$93\.42<\/span>/);
    expect(html).toContain('Cash');
    expect(html).toMatch(/<span>Balance due<\/span>\s*<span>\$0\.00<\/span>/);
  });

  it('renders the due date as a tenant-local date, never the raw ISO instant', () => {
    const { container } = renderDetail(apiInvoice({ dueDate: '2026-10-27T02:23:19.595Z' }));
    expect(container.textContent).not.toContain('T02:23:19');
    expect(screen.getAllByText(/Due Oct 27/).length).toBeGreaterThan(0);
  });
});
