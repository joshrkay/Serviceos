// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Invoice {
  id: string;
  invoiceNumber?: string;
  totals?: { totalCents?: number };
  status?: string;
  dueDate?: string;
  lineItems?: { description?: string }[];
}

const h = vi.hoisted(() => ({
  data: [] as Invoice[],
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
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

// eslint-disable-next-line import/first
import Invoices from '../../app/invoices';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Invoices screen', () => {
  it('leads with the work; number + due in the subline; amount trailing; status badge', () => {
    h.data = [
      {
        id: 'i1',
        invoiceNumber: 'INV-1042',
        totals: { totalCents: 123456 },
        status: 'open',
        dueDate: '2099-07-01T00:00:00Z', // far future → not overdue, run-date-independent
        lineItems: [{ description: 'AC tune-up' }],
      },
    ];
    const { getByText } = render(createElement(Invoices));
    expect(getByText('AC tune-up')).toBeTruthy(); // primary = first line item
    // Number + due date in the subline (exact day is tz-dependent).
    expect(getByText(/^INV-1042 · due \w+ \d{1,2}, \d{4}$/)).toBeTruthy();
    // 123456 cents → $1,234.56 (never float math), shown as the trailing amount.
    expect(getByText('$1,234.56')).toBeTruthy();
    expect(getByText('Open')).toBeTruthy(); // status badge (future due → not overdue)
  });

  it('marks a past-due open invoice Overdue', () => {
    h.data = [
      {
        id: 'i3',
        invoiceNumber: 'INV-9',
        totals: { totalCents: 89000 },
        status: 'open',
        dueDate: '2020-01-01T00:00:00Z', // long past
        lineItems: [{ description: 'Capacitor' }],
      },
    ];
    const { getByText } = render(createElement(Invoices));
    expect(getByText('Overdue')).toBeTruthy();
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
});
