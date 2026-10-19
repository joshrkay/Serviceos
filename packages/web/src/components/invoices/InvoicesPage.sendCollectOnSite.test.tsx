/**
 * S5a-2 (U8) — the operator's "Send payment link" sheet on a business that
 * collects in person.
 *
 * The sheet posts POST /api/invoices/:id/send. On "Collect on the spot" the
 * API still sends the invoice, but with a "see your invoice" link and the
 * in-person note instead of a pay button, and its 202 body says which
 * choice it applied (`paymentCollectionMode`). The sheet says so in one
 * plain line so the owner is not told a pay link went out when none did.
 *
 * Real hooks (useDetailQuery / useListQuery / useMutation); the network is
 * stubbed at `fetch`, URL-keyed, as the v3 shell tests do.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';

vi.mock('../shared/CameraCapture', () => ({
  CameraCapture: () => <div data-testid="mock-capture-sheet">Capture open</div>,
}));

import { InvoicesPage } from './InvoicesPage';

const line = {
  id: 'li-1',
  description: 'Labor',
  quantity: 1,
  unitPriceCents: 100000,
  totalCents: 100000,
  category: 'labor',
  sortOrder: 0,
  taxable: true,
};

const openInvoice = {
  id: 'i-open',
  invoiceNumber: 'INV-OPEN',
  status: 'open',
  dueDate: '2099-12-31',
  lineItems: [line],
  totals: {
    subtotalCents: 100000,
    discountCents: 0,
    taxRateBps: 0,
    taxableSubtotalCents: 100000,
    taxCents: 0,
    totalCents: 100000,
  },
  amountPaidCents: 0,
  amountDueCents: 100000,
  customer: { id: 'c1', displayName: 'Open Customer' },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let sends: Array<Record<string, unknown>>;

function stubNetwork(sendReply: Record<string, unknown>) {
  sends = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://app.test');
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.pathname === '/api/invoices/i-open/send') {
        sends.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return Promise.resolve(json(202, sendReply));
      }
      if (method === 'GET' && url.pathname === '/api/invoices/i-open') return Promise.resolve(json(200, openInvoice));
      if (method === 'GET' && url.pathname === '/api/invoices') {
        return Promise.resolve(json(200, { data: [openInvoice], total: 1, page: 1, pageSize: 25 }));
      }
      // Notes, attachments and other side panels: empty.
      if (method === 'GET') return Promise.resolve(json(200, []));
      return Promise.reject(new Error(`unexpected request ${method} ${url.pathname}`));
    }),
  );
}

function renderDetail() {
  return render(
    <MemoryRouter>
      <InvoicesPage defaultSelectedId="i-open" />
    </MemoryRouter>,
  );
}

async function openSheetAndSend() {
  fireEvent.click(await screen.findByRole('button', { name: /resend payment link/i }));
  fireEvent.click(screen.getByRole('button', { name: /^send payment link$/i }));
  await waitFor(() => expect(sends).toHaveLength(1));
}

describe('InvoicesPage send sheet — honours the payment choice (S5a-2, U8)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('collect_on_site: after the send, one line says the customer got the in-person note', async () => {
    stubNetwork({
      viewUrl: 'https://app.test/pay/tok123',
      viewToken: 'tok123',
      channelsSent: [{ channel: 'sms', dispatchId: 'd1' }],
      paymentCollectionMode: 'collect_on_site',
    });
    renderDetail();
    await openSheetAndSend();

    const line = await screen.findByTestId('send-sheet-payment-mode');
    expect(line.textContent).toBe(
      'Sent. Your customer sees the bill with a note that you collect payment in person.',
    );
  });

  it('unavailable: the line says no pay button went out this time', async () => {
    stubNetwork({
      viewUrl: 'https://app.test/pay/tok123',
      viewToken: 'tok123',
      channelsSent: [{ channel: 'sms', dispatchId: 'd1' }],
      paymentCollectionMode: 'unavailable',
    });
    renderDetail();
    await openSheetAndSend();

    const line = await screen.findByTestId('send-sheet-payment-mode');
    expect(line.textContent).toBe(
      "Sent without a pay button. Online payment isn't available right now.",
    );
  });

  it('pay_link: no extra line (today\'s sheet)', async () => {
    stubNetwork({
      viewUrl: 'https://app.test/pay/tok123',
      viewToken: 'tok123',
      channelsSent: [{ channel: 'sms', dispatchId: 'd1' }],
      paymentCollectionMode: 'pay_link',
    });
    renderDetail();
    await openSheetAndSend();

    await waitFor(() => expect(screen.getByText('https://app.test/pay/tok123')).toBeInTheDocument());
    expect(screen.queryByTestId('send-sheet-payment-mode')).not.toBeInTheDocument();
  });
});
