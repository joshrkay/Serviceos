import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TechnicianProfitCard } from './TechnicianProfitCard';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../../utils/api-fetch';

const rollup = {
  jobCount: 2,
  revenueCents: 100000,
  laborCents: 6000,
  materialsCents: 0,
  expensesCents: 0,
  marginCents: 94000,
  marginPct: 94,
  laborUnpriced: false,
  jobs: [
    { jobId: 'j1', jobNumber: 'JOB-1', summary: 'AC repair', revenueCents: 60000, marginCents: 56000, marginPct: 93.3 },
  ],
};

describe('TechnicianProfitCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the technician-profit endpoint and renders the summary', async () => {
    const fn = apiFetch as unknown as ReturnType<typeof vi.fn>;
    fn.mockResolvedValue({ ok: true, json: async () => ({ data: rollup }) });
    render(<TechnicianProfitCard technicianId="tech-1" />);

    expect(await screen.findByText('Technician profitability')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('$1,000.00')).toBeInTheDocument());
    expect(fn.mock.calls[0][0]).toBe('/api/reports/technician-profit/tech-1');
  });

  it('renders nothing when the report is forbidden/unavailable', async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 403 });
    const { container } = render(<TechnicianProfitCard technicianId="tech-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
