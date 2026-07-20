// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface InvoiceDetail {
  id: string;
  invoiceNumber?: string;
  status?: string;
  amountDueCents?: number;
  sentAt?: string | null;
  totals?: { totalCents?: number; subtotalCents?: number; taxCents?: number };
}

const h = vi.hoisted(() => ({
  refetch: vi.fn(),
  data: null as InvoiceDetail | null,
  endpoint: null as string | null,
  issueInvoice: vi.fn(),
  sendInvoice: vi.fn(),
  createInvoicePaymentLink: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'inv-1' }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: (endpoint: string | null) => {
    h.endpoint = endpoint;
    return { data: h.data, isLoading: false, error: null, refetch: h.refetch };
  },
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => vi.fn() }));
vi.mock('../api/invoices', () => ({
  issueInvoice: (...args: unknown[]) => h.issueInvoice(...args),
  sendInvoice: (...args: unknown[]) => h.sendInvoice(...args),
  createInvoicePaymentLink: (...args: unknown[]) => h.createInvoicePaymentLink(...args),
}));
// The Terminal collect panel + record sheet pull in native modules; the screen
// wiring under test is the status-gated action buttons, so stub the children.
vi.mock('../components/CollectPaymentPanel', () => ({ CollectPaymentPanel: () => null }));
vi.mock('../components/RecordPaymentSheet', () => ({ RecordPaymentSheet: () => null }));

// eslint-disable-next-line import/first
import InvoiceDetailScreen from '../../app/invoices/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = null;
  h.endpoint = null;
  h.issueInvoice.mockResolvedValue(undefined);
  h.sendInvoice.mockResolvedValue(undefined);
  h.createInvoicePaymentLink.mockResolvedValue({ url: 'https://pay.test/x', expiresAt: null });
});

afterEach(() => cleanup());

describe('Invoice detail screen', () => {
  it('fetches the invoice by id and renders the total as integer cents', () => {
    h.data = { id: 'inv-1', invoiceNumber: 'INV-9', status: 'open', totals: { totalCents: 124000 }, amountDueCents: 124000 };
    const { getAllByText } = render(createElement(InvoiceDetailScreen));
    expect(h.endpoint).toBe('/api/invoices/inv-1');
    // Renders both as the headline and the amount-due row — 124000 cents → $1,240.00.
    expect(getAllByText('$1,240.00').length).toBeGreaterThan(0);
  });

  it('shows Issue only for a draft and issues it', async () => {
    h.data = { id: 'inv-1', status: 'draft', totals: { totalCents: 50000 }, amountDueCents: 50000 };
    const { getByText, queryByText } = render(createElement(InvoiceDetailScreen));

    expect(getByText('Issue invoice')).toBeTruthy();
    // Draft is not payable → no send / pay-link / record affordances yet.
    expect(queryByText('Send to customer')).toBeNull();
    expect(queryByText('Record payment')).toBeNull();

    fireEvent.click(getByText('Issue invoice'));
    await waitFor(() => expect(h.issueInvoice).toHaveBeenCalled());
    expect(h.refetch).toHaveBeenCalled();
  });

  it('shows get-paid actions for an open invoice with a balance', async () => {
    h.data = { id: 'inv-1', status: 'open', totals: { totalCents: 20000 }, amountDueCents: 20000, sentAt: null };
    const { getByText, queryByText } = render(createElement(InvoiceDetailScreen));

    expect(queryByText('Issue invoice')).toBeNull();
    expect(getByText('Send to customer')).toBeTruthy();
    expect(getByText('Create payment link')).toBeTruthy();
    expect(getByText('Record payment')).toBeTruthy();

    fireEvent.click(getByText('Send to customer'));
    await waitFor(() => expect(h.sendInvoice).toHaveBeenCalled());
  });

  it('labels send as Resend once the invoice has been sent', () => {
    h.data = { id: 'inv-1', status: 'open', totals: { totalCents: 20000 }, amountDueCents: 20000, sentAt: '2026-07-01T00:00:00Z' };
    const { getByText } = render(createElement(InvoiceDetailScreen));
    expect(getByText('Resend to customer')).toBeTruthy();
  });

  it('creates a payment link then offers to open it', async () => {
    h.data = { id: 'inv-1', status: 'open', totals: { totalCents: 20000 }, amountDueCents: 20000 };
    const { getByText } = render(createElement(InvoiceDetailScreen));

    fireEvent.click(getByText('Create payment link'));
    await waitFor(() => expect(getByText('Open payment link')).toBeTruthy());
    expect(getByText('https://pay.test/x')).toBeTruthy();
  });

  it('offers no get-paid actions once fully paid', () => {
    h.data = { id: 'inv-1', status: 'paid', totals: { totalCents: 20000 }, amountDueCents: 0 };
    const { queryByText } = render(createElement(InvoiceDetailScreen));
    expect(queryByText('Send to customer')).toBeNull();
    expect(queryByText('Record payment')).toBeNull();
    expect(queryByText('Issue invoice')).toBeNull();
  });
});
