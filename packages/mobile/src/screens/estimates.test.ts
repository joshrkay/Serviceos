// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Estimate {
  id: string;
  estimateNumber?: string;
  totals?: { totalCents?: number };
  status?: string;
  lineItems?: { description?: string }[];
}

const h = vi.hoisted(() => ({
  data: [] as Estimate[],
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
import Estimates from '../../app/estimates';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Estimates screen', () => {
  it('leads with the work, then the number, amount, and a status badge', () => {
    h.data = [
      {
        id: 'e1',
        estimateNumber: 'EST-1001',
        totals: { totalCents: 493000 },
        status: 'sent',
        lineItems: [{ description: 'Furnace replacement' }],
      },
    ];
    const { getByText } = render(createElement(Estimates));
    expect(getByText('Furnace replacement')).toBeTruthy(); // primary = first line item
    expect(getByText('EST-1001')).toBeTruthy(); // secondary = number
    expect(getByText('$4,930.00')).toBeTruthy(); // trailing amount (integer cents)
    expect(getByText('Sent')).toBeTruthy(); // status badge
  });

  it('falls back to the number when there are no line items', () => {
    h.data = [{ id: 'e2', estimateNumber: 'EST-2', totals: { totalCents: 0 }, status: 'draft' }];
    const { getAllByText, getByText } = render(createElement(Estimates));
    // Number is both the primary (no line item) and the secondary.
    expect(getAllByText('EST-2').length).toBe(2);
    expect(getByText('Draft')).toBeTruthy();
  });

  it('shows the empty state when there are no estimates', () => {
    const { getByText } = render(createElement(Estimates));
    expect(getByText('No estimates yet.')).toBeTruthy();
  });
});
