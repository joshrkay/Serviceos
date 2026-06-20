// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Customer {
  id: string;
  name?: string;
  phone?: string;
  email?: string;
}

const h = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  refetch: vi.fn(),
  data: [] as Customer[],
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: h.back, replace: vi.fn() }),
}));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: () => ({
    data: h.data,
    total: h.data.length,
    isLoading: h.isLoading,
    error: h.error,
    refetch: h.refetch,
  }),
}));

// eslint-disable-next-line import/first
import Customers from '../../app/customers';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Customers screen', () => {
  it('Back is a >=44px tap target and returns to the prior screen', () => {
    const { getByText } = render(createElement(Customers));
    const back = getByText('‹ Back').closest('button')!;
    expect(back.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(back);
    expect(h.back).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when there are no customers', () => {
    const { getByText } = render(createElement(Customers));
    expect(getByText('No customers yet.')).toBeTruthy();
  });

  it('renders one tappable row per customer and opens the detail screen', () => {
    h.data = [
      { id: 'c1', name: 'Acme Plumbing', phone: '555-0100' },
      { id: 'c2', name: 'Beta Builders', email: 'beta@example.com' },
    ];
    const { getByText, container } = render(createElement(Customers));
    expect(getByText('Acme Plumbing')).toBeTruthy();
    expect(getByText('555-0100')).toBeTruthy(); // phone preferred as secondary
    expect(getByText('beta@example.com')).toBeTruthy(); // email fallback

    const row = getByText('Acme Plumbing').closest('button')!;
    expect(row.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(row);
    expect(h.push).toHaveBeenCalledWith('/customers/c1');

    // Every row is a >=44px tap target.
    for (const b of Array.from(container.querySelectorAll('button'))) {
      expect(b.className).toMatch(/\bmin-h-11\b/);
    }
  });

  it('falls back to "Unnamed customer" when a record has no name', () => {
    h.data = [{ id: 'c3' }];
    const { getByText } = render(createElement(Customers));
    expect(getByText('Unnamed customer')).toBeTruthy();
  });

  it('surfaces a fetch error', () => {
    h.error = 'HTTP 500';
    const { getByText } = render(createElement(Customers));
    expect(getByText('HTTP 500')).toBeTruthy();
  });
});
