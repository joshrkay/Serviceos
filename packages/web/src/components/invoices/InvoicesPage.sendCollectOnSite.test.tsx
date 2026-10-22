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

function stubNetwork(sendReply: Record<string, unknown>, sendStatus = 202) {
  sends = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://app.test');
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.pathname === '/api/invoices/i-open/send') {
        sends.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return Promise.resolve(json(sendStatus, sendReply));
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

  it('D-045 — a send refused for want of a pay link shows the reason and never says it was sent', async () => {
    const message =
      "Invoice INV-OPEN was not sent: its pay link couldn't be made (the payment provider did not answer). Try again in a moment, or switch to collecting payment on the spot.";
    stubNetwork({ error: 'PAY_LINK_UNAVAILABLE', message }, 503);
    renderDetail();
    await openSheetAndSend();

    expect(await screen.findByText(`Send failed: ${message}`)).toBeInTheDocument();
    expect(screen.queryByTestId('send-sheet-payment-mode')).not.toBeInTheDocument();
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

describe('InvoicesPage send sheet — a draft whose first send is refused (D-045)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the retry sends without issuing the now-open invoice again', async () => {
    const draft = { ...openInvoice, id: 'i-draft', invoiceNumber: 'INV-DRAFT', status: 'draft', dueDate: undefined };
    const calls: string[] = [];
    let sendAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input), 'http://app.test');
        const method = init?.method ?? 'GET';
        if (method === 'POST') calls.push(url.pathname);
        if (method === 'POST' && url.pathname === '/api/invoices/i-draft/issue') {
          // The API refuses a second issue: the invoice is open now.
          const already = calls.filter((c) => c.endsWith('/issue')).length > 1;
          return Promise.resolve(
            already ? json(400, { message: 'Invalid transition from open to open' }) : json(200, { ...draft, status: 'open' }),
          );
        }
        if (method === 'POST' && url.pathname === '/api/invoices/i-draft/send') {
          sendAttempts += 1;
          return Promise.resolve(
            sendAttempts === 1
              ? json(503, { error: 'PAY_LINK_UNAVAILABLE', message: "Invoice INV-DRAFT was not sent: its pay link couldn't be made." })
              : json(202, { viewUrl: 'https://app.test/pay/tok9', viewToken: 'tok9', paymentCollectionMode: 'pay_link' }),
          );
        }
        if (method === 'GET' && url.pathname === '/api/invoices/i-draft') return Promise.resolve(json(200, draft));
        if (method === 'GET' && url.pathname === '/api/invoices') {
          return Promise.resolve(json(200, { data: [draft], total: 1, page: 1, pageSize: 25 }));
        }
        if (method === 'GET') return Promise.resolve(json(200, []));
        return Promise.reject(new Error(`unexpected request ${method} ${url.pathname}`));
      }),
    );
    render(
      <MemoryRouter>
        <InvoicesPage defaultSelectedId="i-draft" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^send payment link$/i }));
    const sheetSend = () => screen.getAllByRole('button', { name: /^send payment link$/i }).at(-1)!;
    fireEvent.click(sheetSend());
    expect(await screen.findByText(/Send failed: Invoice INV-DRAFT was not sent/)).toBeInTheDocument();

    fireEvent.click(sheetSend());
    await waitFor(() => expect(screen.getByText('https://app.test/pay/tok9')).toBeInTheDocument());
    expect(calls).toEqual([
      '/api/invoices/i-draft/issue',
      '/api/invoices/i-draft/send',
      '/api/invoices/i-draft/send',
    ]);
  });

  it('closed and reopened after the refusal, the sheet does not issue again', async () => {
    let status = 'draft';
    const draft = () => ({ ...openInvoice, id: 'i-draft', invoiceNumber: 'INV-DRAFT', status });
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input), 'http://app.test');
        const method = init?.method ?? 'GET';
        if (method === 'POST') posts.push(url.pathname);
        if (method === 'POST' && url.pathname === '/api/invoices/i-draft/issue') {
          if (status !== 'draft') return Promise.resolve(json(400, { message: 'Invalid transition from open to open' }));
          status = 'open';
          return Promise.resolve(json(200, draft()));
        }
        if (method === 'POST' && url.pathname === '/api/invoices/i-draft/send') {
          return Promise.resolve(json(503, { error: 'PAY_LINK_UNAVAILABLE', message: 'Invoice INV-DRAFT was not sent.' }));
        }
        // The refetch after the issue never lands (a slow network): the
        // detail keeps showing the draft, so only the remembered issue stops
        // a second /issue.
        if (method === 'GET' && url.pathname === '/api/invoices/i-draft') {
          return status === 'draft' ? Promise.resolve(json(200, draft())) : new Promise<Response>(() => {});
        }
        if (method === 'GET' && url.pathname === '/api/invoices') {
          return Promise.resolve(json(200, { data: [{ ...draft(), status: 'draft' }], total: 1, page: 1, pageSize: 25 }));
        }
        if (method === 'GET') return Promise.resolve(json(200, []));
        return Promise.reject(new Error(`unexpected request ${method} ${url.pathname}`));
      }),
    );
    render(
      <MemoryRouter>
        <InvoicesPage defaultSelectedId="i-draft" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^send payment link$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /^send payment link$/i }).at(-1)!);
    expect(await screen.findByText(/Send failed: Invoice INV-DRAFT was not sent/)).toBeInTheDocument();

    // Close the sheet and reopen it while the detail still shows the draft.
    fireEvent.click(document.querySelector('.fixed.inset-0') as Element);
    fireEvent.click(screen.getByRole('button', { name: /^send payment link$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /^send payment link$/i }).at(-1)!);
    await waitFor(() => expect(posts.filter((p) => p.endsWith('/send'))).toHaveLength(2));
    expect(posts.filter((p) => p.endsWith('/issue'))).toHaveLength(1);
  });
});

