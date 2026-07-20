// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Invoice {
  id: string;
  invoiceNumber?: string;
  totals?: { totalCents?: number };
  status?: string;
  dueDate?: string;
}

interface InvoiceDetail {
  id: string;
  invoiceNumber?: string;
  status?: string;
  amountDueCents?: number;
  totals?: { totalCents?: number };
  customer?: { displayName?: string };
}

const h = vi.hoisted(() => ({
  push: vi.fn(),
  data: [] as Invoice[],
  isLoading: false,
  error: null as string | null,
  // Detail-screen state (useDetailQuery is mocked below).
  detail: null as InvoiceDetail | null,
  detailError: null as string | null,
  refetch: vi.fn(),
  issue: vi.fn(),
  send: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => ({ id: 'inv-1' }),
}));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: () => ({
    data: h.data,
    total: h.data.length,
    isLoading: h.isLoading,
    error: h.error,
    refetch: vi.fn(),
  }),
}));
vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: () => ({
    data: h.detail,
    isLoading: false,
    error: h.detailError,
    refetch: h.refetch,
  }),
}));
// Avoid Clerk/expo-router wiring in useApiClient — the screen only forwards the
// returned client into the (mocked) action fns.
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => vi.fn() }));
vi.mock('../api/invoices', () => ({
  issueInvoice: (...args: unknown[]) => h.issue(...args),
  sendInvoice: (...args: unknown[]) => h.send(...args),
}));

// eslint-disable-next-line import/first
import Invoices from '../../app/invoices';
// eslint-disable-next-line import/first
import InvoiceDetailScreen from '../../app/invoices/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.isLoading = false;
  h.error = null;
  h.detail = null;
  h.detailError = null;
  h.refetch.mockResolvedValue(undefined);
  h.issue.mockResolvedValue(undefined);
  h.send.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('Invoices screen', () => {
  it('renders integer cents from totals.totalCents with a thousands separator', () => {
    h.data = [
      { id: 'i1', invoiceNumber: 'INV-1042', totals: { totalCents: 123456 }, status: 'open', dueDate: '2026-07-01T00:00:00Z' },
    ];
    const { getByText } = render(createElement(Invoices));
    // 123456 cents → $1,234.56 (never float math).
    expect(getByText('INV-1042 · $1,234.56')).toBeTruthy();
    expect(getByText('open')).toBeTruthy();
  });

  it('defaults a missing total to $0.00', () => {
    h.data = [{ id: 'i2' }];
    const { getByText } = render(createElement(Invoices));
    expect(getByText(/\$0\.00/)).toBeTruthy();
  });

  it('shows the empty state when there are no invoices', () => {
    const { getByText } = render(createElement(Invoices));
    expect(getByText('No invoices yet.')).toBeTruthy();
  });

  it('filters invoices by search query and opens detail rows', () => {
    h.data = [
      { id: 'i1', invoiceNumber: 'INV-100', totals: { totalCents: 1000 }, status: 'open' },
      { id: 'i2', invoiceNumber: 'INV-200', totals: { totalCents: 2000 }, status: 'draft' },
    ];
    const { getByPlaceholderText, getByText, queryByText } = render(createElement(Invoices));
    fireEvent.change(getByPlaceholderText('Search invoices…'), { target: { value: '200' } });
    expect(queryByText(/INV-100/)).toBeNull();
    fireEvent.click(getByText(/INV-200/).closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/invoices/i2');
  });

  it('renders a >=44px new-invoice control', () => {
    const { getByText } = render(createElement(Invoices));
    const add = getByText('+ New').closest('button')!;
    expect(add.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(add);
    expect(h.push).toHaveBeenCalledWith('/invoices/new');
  });
});

describe('Invoice detail actions (A2/A3 + deferred A8/A9)', () => {
  it('draft shows Issue but not Send', () => {
    h.detail = { id: 'inv-1', invoiceNumber: 'INV-42', status: 'draft', totals: { totalCents: 10000 } };
    const { getByText, queryByText } = render(createElement(InvoiceDetailScreen));
    expect(getByText('Issue invoice')).toBeTruthy();
    expect(queryByText('Send')).toBeNull();
  });

  it('open shows Send + the voice reminder/late-fee hint, not Issue', () => {
    h.detail = { id: 'inv-1', invoiceNumber: 'INV-42', status: 'open', amountDueCents: 5000, totals: { totalCents: 10000 } };
    const { getByText, queryByText } = render(createElement(InvoiceDetailScreen));
    expect(getByText('Send')).toBeTruthy();
    expect(queryByText('Issue invoice')).toBeNull();
    // A8/A9 deferred → the sanctioned voice affordance still surfaces them.
    expect(getByText(/say it out loud/)).toBeTruthy();
  });

  it('partially_paid also exposes Send', () => {
    h.detail = { id: 'inv-1', invoiceNumber: 'INV-42', status: 'partially_paid', amountDueCents: 5000 };
    const { getByText } = render(createElement(InvoiceDetailScreen));
    expect(getByText('Send')).toBeTruthy();
  });

  it('paid shows no actions and no voice hint', () => {
    h.detail = { id: 'inv-1', invoiceNumber: 'INV-42', status: 'paid', totals: { totalCents: 10000 } };
    const { queryByText } = render(createElement(InvoiceDetailScreen));
    expect(queryByText('Issue invoice')).toBeNull();
    expect(queryByText('Send')).toBeNull();
    expect(queryByText(/say it out loud/)).toBeNull();
  });

  it('void shows no actions', () => {
    h.detail = { id: 'inv-1', invoiceNumber: 'INV-42', status: 'void' };
    const { queryByText } = render(createElement(InvoiceDetailScreen));
    expect(queryByText('Issue invoice')).toBeNull();
    expect(queryByText('Send')).toBeNull();
  });

  it('Issue opens a money confirm that names the invoice and only fires on confirm', async () => {
    h.detail = { id: 'inv-1', invoiceNumber: 'INV-42', status: 'draft', totals: { totalCents: 10000 } };
    const { getByText } = render(createElement(InvoiceDetailScreen));

    fireEvent.click(getByText('Issue invoice').closest('button')!);
    // Money-lane confirm copy per the plan ("start the clock").
    expect(getByText('Issue INV-42 and start the clock?')).toBeTruthy();
    expect(h.issue).not.toHaveBeenCalled();

    fireEvent.click(getByText('Issue it').closest('button')!);
    await waitFor(() => expect(h.issue).toHaveBeenCalledWith(expect.anything(), 'inv-1'));
    // No optimistic mutation — the screen re-reads the server's new status.
    expect(h.refetch).toHaveBeenCalled();
  });

  it('Issue confirm can be cancelled without firing', () => {
    h.detail = { id: 'inv-1', invoiceNumber: 'INV-42', status: 'draft' };
    const { getByText, queryByText } = render(createElement(InvoiceDetailScreen));
    fireEvent.click(getByText('Issue invoice').closest('button')!);
    fireEvent.click(getByText('Cancel').closest('button')!);
    expect(queryByText('Issue INV-42 and start the clock?')).toBeNull();
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('Send opens a comms confirm and only fires sendInvoice on confirm', async () => {
    h.detail = { id: 'inv-1', invoiceNumber: 'INV-42', status: 'open', amountDueCents: 5000 };
    const { getByText } = render(createElement(InvoiceDetailScreen));

    fireEvent.click(getByText('Send').closest('button')!);
    expect(getByText('Send INV-42 — this messages your customer.')).toBeTruthy();
    expect(h.send).not.toHaveBeenCalled();

    fireEvent.click(getByText('Send it').closest('button')!);
    await waitFor(() => expect(h.send).toHaveBeenCalledWith(expect.anything(), 'inv-1'));
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('surfaces a server error and does not mutate optimistically', async () => {
    h.detail = { id: 'inv-1', invoiceNumber: 'INV-42', status: 'draft' };
    h.issue.mockRejectedValue({ kind: 'conflict', message: 'This just changed' });
    const { getByText } = render(createElement(InvoiceDetailScreen));
    fireEvent.click(getByText('Issue invoice').closest('button')!);
    fireEvent.click(getByText('Issue it').closest('button')!);
    await waitFor(() => expect(getByText('This just changed')).toBeTruthy());
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it('renders >=44px action targets', () => {
    h.detail = { id: 'inv-1', invoiceNumber: 'INV-42', status: 'draft' };
    const { getByText } = render(createElement(InvoiceDetailScreen));
    const issue = getByText('Issue invoice').closest('button')!;
    expect(issue.className).toMatch(/\bmin-h-11\b/);
  });
});
