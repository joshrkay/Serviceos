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
  it('renders integer cents from totals.totalCents with a thousands separator', () => {
    h.data = [
      { id: 'i1', invoiceNumber: 'INV-1042', totals: { totalCents: 123456 }, status: 'open', dueDate: '2026-07-01T00:00:00Z' },
    ];
    const { getByText } = render(createElement(Invoices));
    // 123456 cents → $1,234.56 (never float math).
    expect(getByText('INV-1042 · $1,234.56')).toBeTruthy();
    // Status is title-cased and a due date is rendered (exact day is tz-dependent).
    expect(getByText(/^Open · due \w+ \d{1,2}, 2026$/)).toBeTruthy();
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
