// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Agreement {
  id: string;
  name: string;
  recurrenceRule: string;
  priceCents: number;
  status?: string;
  nextRunAt?: string;
  customerId?: string;
  startsOn?: string;
  autoGenerateInvoice?: boolean;
  autoGenerateJob?: boolean;
  recentRuns?: { id: string; agreementId: string; scheduledFor: string; status: string }[];
}

const h = vi.hoisted(() => ({
  push: vi.fn(),
  list: [] as Agreement[],
  isLoading: false,
  error: null as string | null,
  detail: null as Agreement | null,
  detailError: null as string | null,
  customer: null as { id: string; displayName?: string } | null,
  tz: 'America/New_York' as string | undefined,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => ({ id: 'a1' }),
}));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: () => ({
    data: h.list,
    total: h.list.length,
    isLoading: h.isLoading,
    error: h.error,
    refetch: vi.fn(),
  }),
}));
vi.mock('../hooks/useDetailQuery', () => ({
  // The detail screen makes TWO detail queries: the agreement, then the
  // customer join. Route by endpoint so both resolve independently.
  useDetailQuery: (endpoint: string | null) => {
    if (endpoint && endpoint.startsWith('/api/agreements/')) {
      return { data: h.detail, isLoading: false, error: h.detailError, refetch: vi.fn() };
    }
    if (endpoint && endpoint.startsWith('/api/customers/')) {
      return { data: h.customer, isLoading: false, error: null, refetch: vi.fn() };
    }
    return { data: null, isLoading: false, error: null, refetch: vi.fn() };
  },
}));
vi.mock('../hooks/useMe', () => ({ useMe: () => ({ me: { timezone: h.tz } }) }));

// eslint-disable-next-line import/first
import Agreements from '../../app/agreements';
// eslint-disable-next-line import/first
import AgreementDetailScreen from '../../app/agreements/[id]';

beforeEach(() => {
  vi.clearAllMocks();
  h.list = [];
  h.isLoading = false;
  h.error = null;
  h.detail = null;
  h.detailError = null;
  h.customer = null;
  h.tz = 'America/New_York';
});

afterEach(() => cleanup());

describe('Agreements list', () => {
  it('renders cadence + next-invoice date (tenant tz) + price (integer cents)', () => {
    h.list = [
      {
        id: 'a1',
        name: 'HVAC Plan',
        recurrenceRule: 'FREQ=MONTHLY',
        priceCents: 12000,
        status: 'active',
        // 02:00Z on Jul 1 is still Jun 30 in America/New_York (UTC-4) — proves
        // the date is rendered in the tenant timezone, not UTC.
        nextRunAt: '2026-07-01T02:00:00Z',
      },
    ];
    const { getByText } = render(createElement(Agreements));
    // 12000 cents → $120.00 (never float math).
    expect(getByText('HVAC Plan · $120.00')).toBeTruthy();
    expect(getByText('Monthly · next Jun 30, 2026 · active')).toBeTruthy();
  });

  it('shows the empty state when there are no agreements', () => {
    const { getByText } = render(createElement(Agreements));
    expect(getByText('No agreements yet.')).toBeTruthy();
  });

  it('opens the detail route on row press', () => {
    h.list = [{ id: 'a1', name: 'HVAC Plan', recurrenceRule: 'FREQ=MONTHLY', priceCents: 12000 }];
    const { getByText } = render(createElement(Agreements));
    fireEvent.click(getByText(/HVAC Plan/).closest('button')!);
    expect(h.push).toHaveBeenCalledWith('/agreements/a1');
  });
});

describe('Agreement detail', () => {
  const base: Agreement = {
    id: 'a1',
    name: 'HVAC Plan',
    recurrenceRule: 'FREQ=MONTHLY',
    priceCents: 12000,
    status: 'active',
    customerId: 'c1',
    startsOn: '2026-01-01',
    autoGenerateInvoice: true,
    autoGenerateJob: false,
    nextRunAt: '2026-07-01T02:00:00Z',
  };

  it('renders the humanized cadence, tenant-tz next date, price, and the joined customer name', () => {
    h.detail = { ...base };
    h.customer = { id: 'c1', displayName: 'Acme Co' };
    const { getByText } = render(createElement(AgreementDetailScreen));
    expect(getByText('$120.00')).toBeTruthy();
    expect(getByText('Monthly')).toBeTruthy();
    expect(getByText('Jun 30, 2026')).toBeTruthy(); // next invoice, tenant tz
    expect(getByText('Acme Co')).toBeTruthy(); // customer-name join
  });

  it('renders the recent runs', () => {
    h.detail = {
      ...base,
      recentRuns: [
        { id: 'r1', agreementId: 'a1', scheduledFor: '2026-06-01', status: 'completed' },
        { id: 'r2', agreementId: 'a1', scheduledFor: '2026-05-01', status: 'failed' },
      ],
    };
    const { getByText } = render(createElement(AgreementDetailScreen));
    expect(getByText('completed')).toBeTruthy();
    expect(getByText('failed')).toBeTruthy();
  });

  it('shows a no-runs message when the agreement has never run', () => {
    h.detail = { ...base, recentRuns: [] };
    const { getByText } = render(createElement(AgreementDetailScreen));
    expect(getByText('No runs yet.')).toBeTruthy();
  });
});
