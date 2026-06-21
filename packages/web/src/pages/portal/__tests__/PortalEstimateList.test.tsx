import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortalEstimateList } from '../PortalEstimateList';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

interface EstimateOverrides {
  status?: string;
  depositRequiredCents?: number;
  depositPaidCents?: number;
  depositStatus?: 'not_required' | 'pending' | 'paid';
  depositPayable?: boolean;
}

function estimate(overrides: EstimateOverrides = {}) {
  return {
    id: 'est-1',
    estimateNumber: 'EST-1000',
    status: overrides.status ?? 'sent',
    totalCents: 10000,
    createdAt: new Date('2026-06-01T12:00:00Z').toISOString(),
    validUntil: null,
    depositRequiredCents: overrides.depositRequiredCents ?? 0,
    depositPaidCents: overrides.depositPaidCents ?? 0,
    depositStatus: overrides.depositStatus ?? 'not_required',
    depositPayable: overrides.depositPayable ?? false,
    publicViewToken: 'view-token-abc',
  };
}

describe('Portal — PortalEstimateList (P10-001)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a Pay deposit CTA + amount when an accepted estimate still owes a deposit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          estimates: [
            estimate({
              status: 'accepted',
              depositRequiredCents: 2500,
              depositPaidCents: 0,
              depositStatus: 'pending',
              depositPayable: true,
            }),
          ],
        }),
      ),
    );

    render(<PortalEstimateList token="tok-1" />);

    const cta = await screen.findByRole('link', { name: 'Pay deposit' });
    expect(cta).toHaveAttribute('href', '/e/view-token-abc');
    // Mobile tap-target contract (CLAUDE.md ≥44px → min-h-11).
    expect(cta.className).toContain('min-h-11');
    expect(screen.getByText('$25.00 deposit due')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'View & respond' }),
    ).not.toBeInTheDocument();
  });

  it('surfaces only the unpaid remainder when a deposit is partially paid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          estimates: [
            estimate({
              status: 'accepted',
              depositRequiredCents: 2500,
              depositPaidCents: 1000,
              depositStatus: 'pending',
              depositPayable: true,
            }),
          ],
        }),
      ),
    );

    render(<PortalEstimateList token="tok-1" />);

    await screen.findByRole('link', { name: 'Pay deposit' });
    expect(screen.getByText('$15.00 deposit due')).toBeInTheDocument();
  });

  it('shows View & respond (no deposit badge) when the deposit is not payable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ estimates: [estimate()] })),
    );

    render(<PortalEstimateList token="tok-1" />);

    const cta = await screen.findByRole('link', { name: 'View & respond' });
    expect(cta).toHaveAttribute('href', '/e/view-token-abc');
    expect(cta.className).toContain('min-h-11');
    expect(screen.queryByText(/deposit due/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Pay deposit' }),
    ).not.toBeInTheDocument();
  });

  it('shows Deposit paid (no CTA) once an accepted estimate deposit is settled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          estimates: [
            estimate({
              status: 'accepted',
              depositRequiredCents: 2500,
              depositPaidCents: 2500,
              depositStatus: 'paid',
              depositPayable: false,
            }),
          ],
        }),
      ),
    );

    render(<PortalEstimateList token="tok-1" />);

    await waitFor(() => {
      expect(screen.getByText('Deposit paid')).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('link', { name: 'Pay deposit' }),
    ).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no estimates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ estimates: [] })),
    );

    render(<PortalEstimateList token="tok-1" />);

    await waitFor(() => {
      expect(screen.getByText('No estimates yet.')).toBeInTheDocument();
    });
  });
});
