/**
 * #1402 §5 (owner-approved) — invoice money actions on the detail page:
 * partial-payment amount entry, correct void wording per the invoice state
 * machine, and a downloadable invoice PDF showing the API's totals.
 * Fixtures are parsed through the shared invoiceResponseSchema.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(useListQuery).mockReturnValue(listQueryResult([]));
  vi.mocked(useMutation).mockReturnValue({ mutate: vi.fn(), isLoading: false, error: null });
  vi.mocked(apiFetch).mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return json({}, 201);
    return json(String(url).startsWith('/api/settings') ? { businessName: 'Acme HVAC' } : []);
  });
});

function renderDetail(invoice: ReturnType<typeof apiInvoice>) {
  const refetch = vi.fn(async () => {});
  vi.mocked(useDetailQuery).mockReturnValue({ data: invoice, isLoading: false, error: null, refetch });
  render(
    <MemoryRouter initialEntries={[`/invoices/${invoice.id}`]}>
      <InvoicesPage defaultSelectedId={invoice.id} />
    </MemoryRouter>,
  );
  return { refetch };
}

const posts = (path: string) =>
  vi.mocked(apiFetch).mock.calls.filter(([u, init]) => String(u) === path && init?.method === 'POST');

// INV-0026 fixture: total $93.42, nothing paid. Far-future due date keeps it 'Unpaid'.
const OPEN = () => apiInvoice({ status: 'open', dueDate: '2099-12-31T00:00:00.000Z' });

describe('#1402 §5 — partial payment amount entry', () => {
  it('records the amount the operator typed (integer cents), not the whole balance', async () => {
    renderDetail(OPEN());
    fireEvent.click(screen.getByRole('button', { name: /mark as paid/i }));

    const amount = screen.getByLabelText('Amount received') as HTMLInputElement;
    expect(amount.value).toBe('93.42');
    fireEvent.change(amount, { target: { value: '40.10' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm payment received/i }));

    await waitFor(() => expect(posts('/api/payments')).toHaveLength(1));
    const body = JSON.parse(String(posts('/api/payments')[0][1]!.body));
    expect(body.amountCents).toBe(4010);
  });

  it('a partial payment does not flip the page to "Payment received" — it shows what the API returns', async () => {
    const { refetch } = renderDetail(OPEN());
    fireEvent.click(screen.getByRole('button', { name: /mark as paid/i }));
    fireEvent.change(screen.getByLabelText('Amount received'), { target: { value: '40.10' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm payment received/i }));

    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(screen.queryByText('Payment received')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark as paid/i })).toBeInTheDocument();
  });

  it('refuses an amount that is not money, without posting', () => {
    renderDetail(OPEN());
    fireEvent.click(screen.getByRole('button', { name: /mark as paid/i }));
    fireEvent.change(screen.getByLabelText('Amount received'), { target: { value: '40.1.2' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm payment received/i }));

    expect(screen.getByText(/enter the amount received/i)).toBeInTheDocument();
    expect(posts('/api/payments')).toHaveLength(0);
  });
});

// Invoice state machine (packages/api/src/invoices/invoice.ts
// INVOICE_STATUS_TRANSITIONS): open / partially_paid → void is allowed;
// paid → void is not (paid can only reopen via a payment reversal).
describe('#1402 §5 — void wording follows the invoice state machine', () => {
  it('an unpaid invoice can be voided after a confirm step (POST /:id/transition status=void)', async () => {
    const inv = OPEN();
    const { refetch } = renderDetail(inv);

    fireEvent.click(screen.getByRole('button', { name: 'Void invoice' }));
    expect(posts(`/api/invoices/${inv.id}/transition`)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, void INV-0026' }));

    await waitFor(() => expect(posts(`/api/invoices/${inv.id}/transition`)).toHaveLength(1));
    const body = JSON.parse(String(posts(`/api/invoices/${inv.id}/transition`)[0][1]!.body));
    expect(body).toEqual({ status: 'void' });
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it('a paid invoice offers no void, and says to record a refund instead', () => {
    renderDetail(apiInvoice({ status: 'paid', amountPaidCents: 9342, amountDueCents: 0 }));

    expect(screen.queryByRole('button', { name: /void/i })).not.toBeInTheDocument();
    expect(screen.getByText(/paid invoices can’t be voided/i)).toHaveTextContent(/record a refund/i);
  });
});

describe('#1402 §5 — invoice PDF', () => {
  function capturePrint(): string[] {
    const written: string[] = [];
    vi.spyOn(window, 'open').mockReturnValue({
      document: { write: (html: string) => written.push(html), close: () => {} },
    } as unknown as Window);
    return written;
  }

  it('Download PDF prints the invoice with the API totals and balance, not a line re-sum', async () => {
    const written = capturePrint();
    renderDetail(apiInvoice({
      invoiceNumber: 'INV-0026',
      status: 'partially_paid',
      amountPaidCents: 4000,
      amountDueCents: 5342,
      dueDate: '2099-12-31T00:00:00.000Z',
    }));

    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));

    await waitFor(() => expect(written.join('')).toContain('INV-0026'));
    const html = written.join('');
    expect(html).toContain('<title>Invoice INV-0026</title>');
    expect(html).toContain('Acme HVAC');
    // INV-0026: lines re-sum to $91.30, the API total with discount + tax is $93.42.
    expect(html).toMatch(/<span>Total<\/span>\s*<span>\$93\.42<\/span>/);
    expect(html).toMatch(/<span>Paid<\/span>\s*<span>\$40\.00<\/span>/);
    expect(html).toMatch(/<span>Balance due<\/span>\s*<span>\$53\.42<\/span>/);
    expect(html).toContain('Due Dec 31, 2099');
  });
});
