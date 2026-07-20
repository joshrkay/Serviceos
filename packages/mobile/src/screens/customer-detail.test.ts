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
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  refetch: vi.fn(),
  callError: null as string | null,
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
vi.mock('../components/Toast', () => ({
  useToast: () => ({ showToast: h.showToast, showErrorToast: h.showErrorToast, hideToast: vi.fn() }),
}));
vi.mock('../lib/useReconnectRetry', () => ({ useReconnectRetry: vi.fn() }));
vi.mock('../messaging/startCustomerConversation', () => ({
  startCustomerConversation: (...args: unknown[]) => h.startConversation(...args),
}));
vi.mock('../calls/useStartCall', () => ({
  useStartCall: () => ({ startCall: h.startCall, isCalling: false, error: h.callError }),
}));
vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: (endpoint: string | null) => {
    h.endpoint = endpoint;
    return { data: h.data, isLoading: h.isLoading, error: h.error, refetch: h.refetch };
  },
}));

// eslint-disable-next-line import/first
import CustomerDetail from '../../app/customers/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = null;
  h.isLoading = false;
  h.error = null;
  h.callError = null;
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

  it('surfaces a fetch error as a friendly state (body is the surfaced message)', () => {
    h.error = 'Customer not found: c1';
    const { getByText } = render(createElement(CustomerDetail));
    expect(getByText('Customer not found: c1')).toBeTruthy();
  });

  it('toasts a call failure instead of pushing a destructive line into the card', async () => {
    h.data = { id: 'c1', displayName: 'Acme Plumbing', primaryPhone: '555-0100' };
    h.callError = 'This customer has opted out of contact (replied STOP).';
    render(createElement(CustomerDetail));
    await waitFor(() =>
      expect(h.showToast).toHaveBeenCalledWith({
        title: 'This customer has opted out of contact (replied STOP).',
        tone: 'error',
      }),
    );
  });

  // C3 — add service location.
  it('adds a service location, POSTing the customer-scoped address to /api/locations', async () => {
    h.data = { id: 'c1', displayName: 'Acme Plumbing' };
    h.api.mockResolvedValue(new Response(JSON.stringify({ id: 'loc1' }), { status: 201 }));
    const { getByText, getByPlaceholderText } = render(createElement(CustomerDetail));

    fireEvent.click(getByText('Add location').closest('button')!);
    fireEvent.change(getByPlaceholderText('Street address'), { target: { value: '1 Main St' } });
    fireEvent.change(getByPlaceholderText('City'), { target: { value: 'Austin' } });
    fireEvent.change(getByPlaceholderText('State'), { target: { value: 'TX' } });
    fireEvent.change(getByPlaceholderText('ZIP'), { target: { value: '78701' } });
    fireEvent.click(getByText('Save').closest('button')!);

    await waitFor(() => {
      const call = h.api.mock.calls.find((c: unknown[]) => c[0] === '/api/locations');
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        customerId: 'c1',
        street1: '1 Main St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      });
    });
  });

  it('shows an inline validation error and does not POST when location fields are missing', () => {
    h.data = { id: 'c1', displayName: 'Acme Plumbing' };
    const { getByText } = render(createElement(CustomerDetail));
    fireEvent.click(getByText('Add location').closest('button')!);
    fireEvent.click(getByText('Save').closest('button')!);
    expect(getByText('Street, city, state, and ZIP are all required.')).toBeTruthy();
    expect(h.api).not.toHaveBeenCalled();
  });

  // C6 — manual note composer.
  it('adds a manual note, POSTing entityType customer to /api/notes', async () => {
    h.data = { id: 'c1', displayName: 'Acme Plumbing' };
    h.api.mockResolvedValue(new Response(JSON.stringify({ id: 'n1' }), { status: 201 }));
    const { getByText, getByPlaceholderText } = render(createElement(CustomerDetail));

    fireEvent.click(getByText('Add note').closest('button')!);
    fireEvent.change(getByPlaceholderText('Add a note about this customer'), {
      target: { value: 'Called back, resolved' },
    });
    fireEvent.click(getByText('Save').closest('button')!);

    await waitFor(() => {
      const call = h.api.mock.calls.find((c: unknown[]) => c[0] === '/api/notes');
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        entityType: 'customer',
        entityId: 'c1',
        content: 'Called back, resolved',
        isPinned: false,
      });
    });
  });

  it('blocks an empty note with an inline message', () => {
    h.data = { id: 'c1', displayName: 'Acme Plumbing' };
    const { getByText } = render(createElement(CustomerDetail));
    fireEvent.click(getByText('Add note').closest('button')!);
    fireEvent.click(getByText('Save').closest('button')!);
    expect(getByText('Write something before saving.')).toBeTruthy();
    expect(h.api).not.toHaveBeenCalled();
  });
});
