// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TierLineInput } from '../estimates/tierGroups';

interface EstimateDetail {
  id: string;
  estimateNumber?: string;
  status?: string;
  validUntil?: string;
  lineItems?: TierLineInput[];
  totals?: { totalCents?: number; subtotalCents?: number; taxCents?: number };
  customer?: { displayName?: string; firstName?: string; lastName?: string; email?: string };
}

const h = vi.hoisted(() => ({
  refetch: vi.fn(),
  data: null as EstimateDetail | null,
  isLoading: false,
  error: null as string | null,
  endpoint: null as string | null,
  sendEstimate: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'est-1' }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: (endpoint: string | null) => {
    h.endpoint = endpoint;
    return { data: h.data, isLoading: h.isLoading, error: h.error, refetch: h.refetch };
  },
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => vi.fn() }));
vi.mock('../api/estimates', () => ({
  sendEstimate: (...args: unknown[]) => h.sendEstimate(...args),
}));

// eslint-disable-next-line import/first
import EstimateDetailScreen from '../../app/estimates/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = null;
  h.isLoading = false;
  h.error = null;
  h.endpoint = null;
  h.sendEstimate.mockResolvedValue(undefined);
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

  it('renders good-better-best tiers with the recommended option and add-ons', () => {
    h.data = {
      id: 'est-1',
      estimateNumber: 'EST-T',
      status: 'draft',
      totals: { totalCents: 700000 },
      lineItems: [
        { id: 'base', description: 'Service call', unitPriceCents: 9900, totalCents: 9900 },
        { id: 'good', description: 'Good unit', groupKey: 'sys', groupLabel: 'System', unitPriceCents: 500000, totalCents: 500000 },
        { id: 'better', description: 'Better unit', groupKey: 'sys', groupLabel: 'System', unitPriceCents: 700000, totalCents: 700000, isDefaultSelected: true },
        { id: 'addon', description: 'Surge protector', isOptional: true, unitPriceCents: 12000, totalCents: 12000 },
      ],
    };
    const { getByText, getAllByText } = render(createElement(EstimateDetailScreen));
    expect(getByText('System — choose one')).toBeTruthy();
    expect(getByText('Optional add-ons')).toBeTruthy();
    expect(getByText('Good unit')).toBeTruthy();
    expect(getByText('Better unit')).toBeTruthy();
    // The default-selected tier is flagged "Recommended".
    expect(getAllByText('Recommended').length).toBeGreaterThan(0);
    expect(getByText('Surge protector')).toBeTruthy();
  });

  it('sends a draft estimate', async () => {
    h.data = { id: 'est-1', status: 'draft', totals: { totalCents: 1000 } };
    const { getByText } = render(createElement(EstimateDetailScreen));
    fireEvent.click(getByText('Send estimate'));
    await waitFor(() => expect(h.sendEstimate).toHaveBeenCalled());
    expect(h.refetch).toHaveBeenCalled();
  });

  it('labels send as Resend for a sent estimate and hides it once accepted', () => {
    h.data = { id: 'est-1', status: 'sent', totals: { totalCents: 1000 } };
    const sent = render(createElement(EstimateDetailScreen));
    expect(sent.getByText('Resend estimate')).toBeTruthy();
    cleanup();

    h.data = { id: 'est-1', status: 'accepted', totals: { totalCents: 1000 } };
    const accepted = render(createElement(EstimateDetailScreen));
    expect(accepted.queryByText('Send estimate')).toBeNull();
    expect(accepted.queryByText('Resend estimate')).toBeNull();
  });
});
