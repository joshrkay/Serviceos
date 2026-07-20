// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface EstimateDetail {
  id: string;
  estimateNumber?: string;
  status?: string;
  validUntil?: string;
  totals?: { totalCents?: number; subtotalCents?: number; taxCents?: number };
  customer?: { displayName?: string; firstName?: string; lastName?: string; email?: string };
}

const h = vi.hoisted(() => ({
  refetch: vi.fn(),
  api: vi.fn(),
  send: vi.fn(),
  data: null as EstimateDetail | null,
  isLoading: false,
  error: null as string | null,
  endpoint: null as string | null,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'est-1' }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../api/estimates', () => ({
  sendEstimate: (...args: unknown[]) => h.send(...args),
}));
vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: (endpoint: string | null) => {
    h.endpoint = endpoint;
    return { data: h.data, isLoading: h.isLoading, error: h.error, refetch: h.refetch };
  },
}));

// eslint-disable-next-line import/first
import EstimateDetailScreen from '../../app/estimates/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = null;
  h.isLoading = false;
  h.error = null;
  h.endpoint = null;
  h.send.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('Estimate detail screen', () => {
  it('fetches the estimate by id from /api/estimates/:id', () => {
    render(createElement(EstimateDetailScreen));
    expect(h.endpoint).toBe('/api/estimates/est-1');
  });

  it('renders the total from totals.totalCents as integer cents', () => {
    h.data = {
      id: 'est-1',
      estimateNumber: 'EST-100',
      status: 'sent',
      totals: { totalCents: 123456, subtotalCents: 114000, taxCents: 9456 },
      customer: { displayName: 'Acme Co', email: 'ops@acme.test' },
    };
    const { getByText } = render(createElement(EstimateDetailScreen));
    // 123456 cents → $1,234.56 (never float math).
    expect(getByText('$1,234.56')).toBeTruthy();
    expect(getByText('EST-100')).toBeTruthy();
    expect(getByText('Acme Co')).toBeTruthy();
  });

  it('defaults a missing total to $0.00', () => {
    h.data = { id: 'est-1', estimateNumber: 'EST-X', status: 'draft' };
    const { getAllByText } = render(createElement(EstimateDetailScreen));
    // total + subtotal + tax all default to $0.00 when totals are absent.
    expect(getAllByText('$0.00').length).toBeGreaterThan(0);
  });

  it('surfaces a load error', () => {
    h.error = 'Network down';
    const { getByText } = render(createElement(EstimateDetailScreen));
    expect(getByText(/Try again/)).toBeTruthy();
  });

  it('refetches when Try again is pressed', () => {
    h.error = 'Network down';
    const { getByText } = render(createElement(EstimateDetailScreen));
    fireEvent.click(getByText(/Try again/).closest('button')!);
    expect(h.refetch).toHaveBeenCalled();
  });

  it('composes the customer name from first/last when displayName is absent', () => {
    h.data = {
      id: 'est-1',
      status: 'sent',
      customer: { firstName: 'Jane', lastName: 'Doe' },
    } as EstimateDetail;
    const { getByText } = render(createElement(EstimateDetailScreen));
    expect(getByText('Jane Doe')).toBeTruthy();
  });
});

describe('Estimate detail — A7 nudge affordance', () => {
  it('offers the nudge on a sent (unaccepted) estimate', () => {
    h.data = { id: 'est-1', estimateNumber: 'EST-1', status: 'sent' };
    const { getByText } = render(createElement(EstimateDetailScreen));
    expect(getByText('Nudge customer')).toBeTruthy();
  });

  it('hides the nudge for accepted / expired / rejected / draft estimates', () => {
    for (const status of ['accepted', 'expired', 'rejected', 'draft']) {
      h.data = { id: 'est-1', status };
      const { queryByText, unmount } = render(createElement(EstimateDetailScreen));
      expect(queryByText('Nudge customer')).toBeNull();
      unmount();
    }
  });

  it('renders the nudge control as a >=44px tap target', () => {
    h.data = { id: 'est-1', status: 'sent' };
    const { getByText } = render(createElement(EstimateDetailScreen));
    expect(getByText('Nudge customer').closest('button')!.className).toMatch(/\bmin-h-11\b/);
  });

  it('requires a comms confirm — sendEstimate fires only after confirmation', async () => {
    h.data = {
      id: 'est-1',
      status: 'sent',
      customer: { displayName: 'Acme Co' },
    };
    const { getByText, queryByText } = render(createElement(EstimateDetailScreen));

    // Tapping Nudge opens the confirm; nothing is sent yet.
    fireEvent.click(getByText('Nudge customer').closest('button')!);
    expect(getByText(/re-send the estimate link/)).toBeTruthy();
    expect(h.send).not.toHaveBeenCalled();

    // Confirming re-sends via the /send route (existing client fn) and re-reads.
    fireEvent.click(getByText('Send reminder').closest('button')!);
    await waitFor(() => expect(h.send).toHaveBeenCalledWith(h.api, 'est-1'));
    await waitFor(() => expect(h.refetch).toHaveBeenCalled());
    // Confirm sheet disappears afterward.
    await waitFor(() => expect(queryByText(/re-send the estimate link/)).toBeNull());
  });

  it('cancels the confirm without sending', () => {
    h.data = { id: 'est-1', status: 'sent' };
    const { getByText, queryByText } = render(createElement(EstimateDetailScreen));
    fireEvent.click(getByText('Nudge customer').closest('button')!);
    fireEvent.click(getByText('Cancel').closest('button')!);
    expect(queryByText(/re-send the estimate link/)).toBeNull();
    expect(h.send).not.toHaveBeenCalled();
  });
});
