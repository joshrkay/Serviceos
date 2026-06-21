import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoreKpisCard } from './CoreKpisCard';

const mockApiFetch = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../lib/apiClient', () => ({ useApiClient: () => mockApiFetch }));
vi.mock('react-router', () => ({ useNavigate: () => mockNavigate }));

const BASE = {
  month: '2026-06',
  revenueCents: 1_250_000,
  priorMonthRevenueCents: 1_000_000,
  revenueTrendCents: 250_000,
  outstandingCents: 320_000,
  overdueCents: 80_000,
};

const JOBS = { bookedThisPeriod: 9, trend: 3, trendPct: 50 };

/** Route each endpoint independently; jobsBooked defaults to a 503 (omitted). */
function setup(opts: { money?: Record<string, unknown> | number; jobs?: Record<string, unknown> | number } = {}) {
  const money = opts.money ?? BASE;
  const jobs = opts.jobs ?? 503;
  mockApiFetch.mockImplementation((url: string) => {
    if (url.includes('/api/analytics/jobs-booked')) {
      return typeof jobs === 'number'
        ? Promise.resolve({ ok: false, status: jobs })
        : Promise.resolve({ ok: true, json: async () => ({ data: jobs }) });
    }
    return typeof money === 'number'
      ? Promise.resolve({ ok: false, status: money })
      : Promise.resolve({ ok: true, json: async () => ({ data: money }) });
  });
}

function resolveWith(data: Record<string, unknown>) {
  setup({ money: data });
}

describe('CoreKpisCard', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockNavigate.mockReset();
  });

  it('renders revenue with an up month-over-month comparison and outstanding/overdue', async () => {
    resolveWith(BASE);
    render(<CoreKpisCard />);

    expect(await screen.findByText('$12,500.00')).toBeInTheDocument();
    const trend = screen.getByTestId('kpi-revenue-trend');
    expect(trend).toHaveTextContent('+25% vs last month');
    expect(trend.className).toContain('text-green-600');
    expect(screen.getByText('$3,200.00')).toBeInTheDocument();
    expect(screen.getByText('$800.00 overdue')).toBeInTheDocument();
  });

  it('shows a down comparison in red', async () => {
    resolveWith({ ...BASE, revenueCents: 800_000, revenueTrendCents: -200_000 });
    render(<CoreKpisCard />);
    const trend = await screen.findByTestId('kpi-revenue-trend');
    expect(trend).toHaveTextContent('-20% vs last month');
    expect(trend.className).toContain('text-red-600');
  });

  it('falls back to a neutral label with no prior-month baseline', async () => {
    resolveWith({ ...BASE, priorMonthRevenueCents: 0, revenueTrendCents: 1_250_000 });
    render(<CoreKpisCard />);
    expect(await screen.findByText('vs last month')).toBeInTheDocument();
  });

  it('drills into the money dashboard', async () => {
    resolveWith(BASE);
    render(<CoreKpisCard />);
    const link = await screen.findByText(/money dashboard/i);
    link.click();
    expect(mockNavigate).toHaveBeenCalledWith('/reports/money');
  });

  it('renders nothing when the money dashboard errors', async () => {
    setup({ money: 503, jobs: 503 });
    const { container } = render(<CoreKpisCard />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('omits the jobs-booked tile when that endpoint is unavailable', async () => {
    setup({ money: BASE, jobs: 503 });
    render(<CoreKpisCard />);
    await screen.findByText('$12,500.00');
    expect(screen.queryByTestId('kpi-jobs-booked')).not.toBeInTheDocument();
  });

  it('shows the jobs-booked tile with its MoM trend when available', async () => {
    setup({ money: BASE, jobs: JOBS });
    render(<CoreKpisCard />);
    const tile = await screen.findByTestId('kpi-jobs-booked');
    expect(tile).toHaveTextContent('9');
    expect(tile).toHaveTextContent('+50% vs last month');
  });
});
