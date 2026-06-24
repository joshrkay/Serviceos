// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
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
  push: vi.fn(),
  data: [] as Invoice[],
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
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
