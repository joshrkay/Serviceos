/**
 * Sweep-2 S4 — JobProfitCard wires the previously-unconsumed
 * GET /api/reports/job-profit/:jobId onto JobDetail. Renders revenue /
 * costs / margin when data comes back; hides entirely on 404/503/403.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../../../utils/api-fetch';
import { JobProfitCard, type JobProfit } from '../JobProfitCard';

const profit: JobProfit = {
  revenueCents: 185000,
  laborCents: 24000,
  laborMinutes: 240,
  materialsCents: 10000,
  expensesCents: 5000,
  marginCents: 146000,
  marginPct: 78.9,
  laborUnpriced: false,
};

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

describe('JobProfitCard (sweep-2 S4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the job-profit endpoint and renders revenue, costs, and margin', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: profit }) });
    render(<JobProfitCard jobId="job-1" />);

    expect(await screen.findByTestId('job-profit-card')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/reports/job-profit/job-1');
    expect(screen.getByText('Job costing')).toBeInTheDocument();
    expect(screen.getByTestId('job-profit-revenue')).toHaveTextContent('$1,850.00');
    expect(screen.getByTestId('job-profit-margin')).toHaveTextContent('$1,460.00');
    expect(screen.getByTestId('job-profit-margin')).toHaveTextContent('78.9%');
    expect(screen.getByTestId('job-profit-labor')).toHaveTextContent('$240.00');
    // Materials + expenses collapse into one metric (integer-cents math).
    expect(screen.getByTestId('job-profit-materials')).toHaveTextContent('$150.00');
    expect(screen.queryByTestId('job-profit-labor-unpriced')).not.toBeInTheDocument();
  });

  it('flags unpriced labor with the settings hint', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { ...profit, laborCents: null, laborUnpriced: true },
      }),
    });
    render(<JobProfitCard jobId="job-1" />);

    expect(await screen.findByTestId('job-profit-labor-unpriced')).toBeInTheDocument();
    expect(screen.getByTestId('job-profit-labor')).toHaveTextContent('—');
  });

  it('renders nothing on 404 (job not found)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const { container } = render(<JobProfitCard jobId="job-404" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing on 503 (report not configured)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const { container } = render(<JobProfitCard jobId="job-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when the fetch itself rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const { container } = render(<JobProfitCard jobId="job-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
