// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface JobDetail {
  id: string;
  jobNumber?: string;
  status?: string;
}
interface JobProfit {
  revenueCents: number;
  laborCents: number | null;
  laborMinutes: number;
  materialsCents: number;
  expensesCents: number;
  marginCents: number;
  marginPct: number | null;
  laborUnpriced: boolean;
}

const h = vi.hoisted(() => ({
  job: null as JobDetail | null,
  profit: null as JobProfit | null,
  permissions: [] as string[],
  endpoints: [] as string[],
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'job-1' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useMe', () => ({ useMe: () => ({ me: { permissions: h.permissions } }) }));
// One mock serves both useDetailQuery call sites — branch on the endpoint.
vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: (endpoint: string | null) => {
    if (endpoint) h.endpoints.push(endpoint);
    if (endpoint?.startsWith('/api/reports/job-profit/')) {
      return { data: h.profit, isLoading: false, error: null, refetch: vi.fn() };
    }
    return { data: h.job, isLoading: false, error: null, refetch: vi.fn() };
  },
}));

// eslint-disable-next-line import/first
import JobDetailScreen from '../../app/jobs/[id]';

const PROFIT: JobProfit = {
  revenueCents: 240000,
  laborCents: 60000,
  laborMinutes: 180,
  materialsCents: 0,
  expensesCents: 8000,
  marginCents: 172000,
  marginPct: 71.7,
  laborUnpriced: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.job = { id: 'job-1', jobNumber: 'JOB-1', status: 'scheduled' };
  h.profit = PROFIT;
  h.permissions = [];
  h.endpoints = [];
});

afterEach(() => cleanup());

describe('Job detail screen', () => {
  it('shows the job cost card (and fetches profit) for owners/dispatchers', () => {
    h.permissions = ['invoices:view'];
    const { getByText } = render(createElement(JobDetailScreen));
    expect(getByText(/Job cost/)).toBeTruthy();
    expect(getByText('$80.00')).toBeTruthy(); // expenses line
    expect(h.endpoints).toContain('/api/reports/job-profit/job-1');
  });

  it('omits the cost card and never fetches profit for technicians', () => {
    h.permissions = ['jobs:view'];
    const { queryByText } = render(createElement(JobDetailScreen));
    expect(queryByText(/Job cost/)).toBeNull();
    expect(h.endpoints).not.toContain('/api/reports/job-profit/job-1');
  });
});
