// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface EstimateDetail {
  id: string;
  estimateNumber?: string;
  status?: string;
  validUntil?: string;
  totals?: { totalCents?: number; subtotalCents?: number; taxCents?: number };
  customer?: { displayName?: string; email?: string };
}

const h = vi.hoisted(() => ({
  refetch: vi.fn(),
  data: null as EstimateDetail | null,
  isLoading: false,
  error: null as string | null,
  endpoint: null as string | null,
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

// eslint-disable-next-line import/first
import EstimateDetailScreen from '../../app/estimates/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = null;
  h.isLoading = false;
  h.error = null;
  h.endpoint = null;
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
});
