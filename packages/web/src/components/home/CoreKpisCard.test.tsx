import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoreKpisCard } from './CoreKpisCard';

const mockApiFetch = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../lib/apiClient', () => ({ useApiClient: () => mockApiFetch }));
vi.mock('react-router', () => ({ useNavigate: () => mockNavigate }));

function resolveWith(data: Record<string, unknown>) {
  mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ data }) });
}

const BASE = {
  month: '2026-06',
  revenueCents: 1_250_000,
  priorMonthRevenueCents: 1_000_000,
  revenueTrendCents: 250_000,
  outstandingCents: 320_000,
  overdueCents: 80_000,
};

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

  it('renders nothing on error', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 503 });
    const { container } = render(<CoreKpisCard />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
