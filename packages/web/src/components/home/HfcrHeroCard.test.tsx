import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HfcrHeroCard } from './HfcrHeroCard';

const mockApiFetch = vi.fn();

vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => mockApiFetch,
}));

function resolveWith(data: Record<string, unknown>) {
  mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ data }) });
}

describe('HfcrHeroCard', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it('renders the hands-free total via the shared formatter + recovered-call count', async () => {
    resolveWith({
      month: '2026-06',
      hfcrCents: 123_450,
      handsFreeInvoiceCount: 3,
      recoveredCallCount: 2,
      consideredPaymentCount: 5,
    });

    render(<HfcrHeroCard />);

    // Shared formatCurrency keeps grouping + cents (123450 -> "$1,234.50").
    const amount = await screen.findByTestId('hfcr-amount');
    expect(amount).toHaveTextContent('$1,234.50');
    expect(screen.getByText(/2 calls recovered/)).toBeInTheDocument();

    // Mobile class-contract: the number wraps instead of overflowing at 320px.
    expect(amount.className).toContain('break-words');
    expect(amount.className).toContain('tabular-nums');
  });

  it('shows the onboarding payoff (no deflating $0) when nothing is collected yet', async () => {
    resolveWith({
      month: '2026-06',
      hfcrCents: 0,
      handsFreeInvoiceCount: 0,
      recoveredCallCount: 0,
      consideredPaymentCount: 0,
    });

    render(<HfcrHeroCard />);

    await screen.findByTestId('hfcr-hero');
    expect(screen.getByText(/first hands-free dollar will land here/i)).toBeInTheDocument();
    expect(screen.queryByTestId('hfcr-amount')).not.toBeInTheDocument();
  });

  it('renders nothing on error (never flashes a broken hero)', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 503 });

    const { container } = render(<HfcrHeroCard />);
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('hfcr-hero')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
