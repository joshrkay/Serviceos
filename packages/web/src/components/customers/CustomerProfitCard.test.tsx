import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerProfitCard } from './CustomerProfitCard';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../../utils/api-fetch';

const profit = {
  customerId: 'c1',
  jobCount: 2,
  revenueCents: 100000,
  laborCents: 6000,
  materialsCents: 1500,
  expensesCents: 500,
  marginCents: 92000,
  marginPct: 92,
  laborUnpriced: false,
  jobs: [
    { jobId: 'j1', jobNumber: 'JOB-1', summary: 'AC repair', revenueCents: 80000, marginCents: 74000, marginPct: 92.5 },
    { jobId: 'j2', jobNumber: 'JOB-2', summary: 'Tune-up', revenueCents: 20000, marginCents: 18000, marginPct: 90 },
  ],
};

describe('CustomerProfitCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the profitability summary from the API', async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: profit }),
    });
    render(<CustomerProfitCard customerId="c1" />);

    expect(await screen.findByText('Profitability')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('$1,000.00')).toBeInTheDocument()); // revenue
    expect(screen.getByText('$920.00')).toBeInTheDocument(); // margin
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText(/JOB-1 · AC repair/)).toBeInTheDocument();
  });

  it('shows the unpriced-labor caveat', async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { ...profit, laborUnpriced: true } }),
    });
    render(<CustomerProfitCard customerId="c1" />);
    expect(await screen.findByText(/Labor is excluded/)).toBeInTheDocument();
  });

  it('renders nothing when the report is unavailable (503)', async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 });
    const { container } = render(<CustomerProfitCard customerId="c1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
