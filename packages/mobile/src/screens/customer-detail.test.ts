// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Customer {
  id: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
}

const h = vi.hoisted(() => ({
  back: vi.fn(),
  data: null as Customer | null,
  isLoading: false,
  error: null as string | null,
  endpoint: null as string | null,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'c1' }),
  useRouter: () => ({ back: h.back, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: (endpoint: string | null) => {
    h.endpoint = endpoint;
    return { data: h.data, isLoading: h.isLoading, error: h.error, refetch: vi.fn() };
  },
}));

// eslint-disable-next-line import/first
import CustomerDetail from '../../app/customers/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = null;
  h.isLoading = false;
  h.error = null;
  h.endpoint = null;
});

afterEach(() => cleanup());

describe('Customer detail screen', () => {
  it('fetches the customer keyed by the route param', () => {
    render(createElement(CustomerDetail));
    expect(h.endpoint).toBe('/api/customers/c1');
  });

  it('Back is a >=44px tap target and returns to the list', () => {
    const { getByText } = render(createElement(CustomerDetail));
    const back = getByText('‹ Customers').closest('button')!;
    expect(back.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(back);
    expect(h.back).toHaveBeenCalledTimes(1);
  });

  it('renders the name and only the contact rows that are present', () => {
    h.data = { id: 'c1', name: 'Acme Plumbing', phone: '555-0100', email: 'a@acme.test' };
    const { getByText, queryByText } = render(createElement(CustomerDetail));
    expect(getByText('Acme Plumbing')).toBeTruthy();
    expect(getByText('555-0100')).toBeTruthy();
    expect(getByText('a@acme.test')).toBeTruthy();
    // No address on this record → the Address row is omitted entirely.
    expect(queryByText('Address')).toBeNull();
  });

  it('surfaces a fetch error', () => {
    h.error = 'HTTP 404';
    const { getByText } = render(createElement(CustomerDetail));
    expect(getByText('HTTP 404')).toBeTruthy();
  });
});
