// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobProfit } from './JobCostCard';

const h = vi.hoisted(() => ({
  data: null as JobProfit | null,
  isLoading: false,
  error: null as string | null,
  endpoint: null as string | null,
}));

vi.mock('../hooks/useDetailQuery', () => ({
  useDetailQuery: (endpoint: string | null) => {
    h.endpoint = endpoint;
    return { data: h.data, isLoading: h.isLoading, error: h.error, refetch: vi.fn() };
  },
}));

// eslint-disable-next-line import/first
import { JobCostCard } from './JobCostCard';

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
  h.data = null;
  h.isLoading = false;
  h.error = null;
  h.endpoint = null;
});

afterEach(() => cleanup());

describe('JobCostCard', () => {
  it('renders nothing and never fetches when disabled', () => {
    const { queryByText } = render(createElement(JobCostCard, { jobId: 'job-1', enabled: false }));
    expect(queryByText(/Job cost/)).toBeNull();
    expect(h.endpoint).toBeNull();
  });

  it('fetches the job-profit rollup when enabled', () => {
    h.data = PROFIT;
    render(createElement(JobCostCard, { jobId: 'job-1', enabled: true }));
    expect(h.endpoint).toBe('/api/reports/job-profit/job-1');
  });

  it('renders revenue, expenses, and margin as integer cents', () => {
    h.data = PROFIT;
    const { getByText } = render(createElement(JobCostCard, { jobId: 'job-1', enabled: true }));
    expect(getByText('$2,400.00')).toBeTruthy(); // revenue
    expect(getByText('$80.00')).toBeTruthy(); // expenses
    expect(getByText('$1,720.00')).toBeTruthy(); // margin
    expect(getByText('Margin (71.7%)')).toBeTruthy();
  });

  it('hides materials when zero and shows it when present', () => {
    h.data = { ...PROFIT, materialsCents: 0 };
    const zero = render(createElement(JobCostCard, { jobId: 'job-1', enabled: true }));
    expect(zero.queryByText('Materials')).toBeNull();
    cleanup();

    h.data = { ...PROFIT, materialsCents: 5000 };
    const withMaterials = render(createElement(JobCostCard, { jobId: 'job-1', enabled: true }));
    expect(withMaterials.getByText('Materials')).toBeTruthy();
    expect(withMaterials.getByText('$50.00')).toBeTruthy();
  });

  it('flags unpriced labor with a caveat and no labor figure', () => {
    h.data = { ...PROFIT, laborCents: null, laborUnpriced: true };
    const { getByText } = render(createElement(JobCostCard, { jobId: 'job-1', enabled: true }));
    expect(getByText('Labor (rate unset)')).toBeTruthy();
    expect(getByText(/set an hourly rate/)).toBeTruthy();
  });

  it('shows a soft failure line on error', () => {
    h.error = 'boom';
    const { getByText } = render(createElement(JobCostCard, { jobId: 'job-1', enabled: true }));
    expect(getByText(/Couldn't load/)).toBeTruthy();
  });
});
