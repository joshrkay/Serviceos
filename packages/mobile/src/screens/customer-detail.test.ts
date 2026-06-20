// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Customer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  email?: string;
}

const h = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  api: vi.fn(),
  startConversation: vi.fn(),
  startCall: vi.fn(),
  data: null as Customer | null,
  isLoading: false,
  error: null as string | null,
  endpoint: null as string | null,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'c1' }),
  useRouter: () => ({ back: h.back, push: h.push, replace: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../messaging/startCustomerConversation', () => ({
  startCustomerConversation: (...args: unknown[]) => h.startConversation(...args),
}));
vi.mock('../calls/useStartCall', () => ({
  useStartCall: () => ({ startCall: h.startCall, isCalling: false, error: null }),
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

  it('derives the name and renders only the contact rows present', () => {
    h.data = { id: 'c1', firstName: 'Acme', lastName: 'Plumbing', primaryPhone: '555-0100', email: 'a@acme.test' };
    const { getByText, queryByText } = render(createElement(CustomerDetail));
    expect(getByText('Acme Plumbing')).toBeTruthy();
    expect(getByText('555-0100')).toBeTruthy();
    expect(getByText('a@acme.test')).toBeTruthy();
    expect(queryByText('Alt phone')).toBeNull(); // no secondaryPhone
  });

  it('opens the customer thread from the Message action', async () => {
    h.data = { id: 'c1', displayName: 'Acme Plumbing', primaryPhone: '555-0100' };
    h.startConversation.mockResolvedValue('conv-42');
    const { getByText } = render(createElement(CustomerDetail));
    const btn = getByText('Message').closest('button')!;
    expect(btn.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(btn);
    await waitFor(() => expect(h.startConversation).toHaveBeenCalledWith(h.api, 'c1'));
    await waitFor(() =>
      expect(h.push).toHaveBeenCalledWith({
        pathname: '/messages/[id]',
        params: { id: 'conv-42', title: 'Acme Plumbing' },
      }),
    );
  });

  it('starts a click-to-call from the Call action (>=44px)', () => {
    h.data = { id: 'c1', displayName: 'Acme Plumbing', primaryPhone: '555-0100' };
    const { getByText } = render(createElement(CustomerDetail));
    const call = getByText('Call').closest('button')!;
    expect(call.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(call);
    expect(h.startCall).toHaveBeenCalledWith('c1');
  });

  it('disables Call when the customer has no phone', () => {
    h.data = { id: 'c1', displayName: 'No Phone Co' };
    const { getByText } = render(createElement(CustomerDetail));
    expect(getByText('Call').closest('button')!.disabled).toBe(true);
  });

  it('surfaces a fetch error', () => {
    h.error = 'HTTP 404';
    const { getByText } = render(createElement(CustomerDetail));
    expect(getByText('HTTP 404')).toBeTruthy();
  });
});
