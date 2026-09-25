/**
 * UsageBanner — the in-app half of the AI-minute usage alerts: shows at
 * 80% and 100% of the included minutes and, most prominently, once the
 * overage cap is reached (calls now ring the owner). Reads
 * GET /api/billing/ai-usage.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => (...args: unknown[]) => apiFetchMock(...args),
}));

import { UsageBanner } from './UsageBanner';

function usage(overrides: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      kind: 'period', planId: 'starter', usedMinutes: 0, includedMinutes: 20, overageMinutes: 0,
      overageCentsPerMinute: 125, projectedChargeCents: 0, capCents: 7900, ...overrides,
    }),
  } as unknown as Response;
}

function renderBanner() {
  return render(<MemoryRouter><UsageBanner /></MemoryRouter>);
}

describe('UsageBanner', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('stays hidden under 80% of the included minutes', async () => {
    apiFetchMock.mockResolvedValue(usage({ usedMinutes: 15 }));
    const { container } = renderBanner();
    await new Promise((r) => setTimeout(r, 0));
    expect(apiFetchMock).toHaveBeenCalledWith('/api/billing/ai-usage');
    expect(container).toBeEmptyDOMElement();
  });

  it('warns at 80%', async () => {
    apiFetchMock.mockResolvedValue(usage({ usedMinutes: 16 }));
    renderBanner();
    expect(await screen.findByText("You've used 16 of your 20 AI answering minutes.")).toBeInTheDocument();
  });

  it('explains overage once the bundle is used', async () => {
    apiFetchMock.mockResolvedValue(usage({ usedMinutes: 25, overageMinutes: 5, projectedChargeCents: 625 }));
    renderBanner();
    expect(
      await screen.findByText('All 20 included AI minutes used — extra minutes are $1.25 each ($6.25 so far).'),
    ).toBeInTheDocument();
  });

  it('says calls are ringing the owner once the cap is reached, and links to the cap', async () => {
    apiFetchMock.mockResolvedValue(
      usage({ usedMinutes: 84, overageMinutes: 64, projectedChargeCents: 7900, capCents: 7900 }),
    );
    renderBanner();
    expect(
      await screen.findByText('Your $79.00 overage cap is reached — calls ring you instead of the AI.'),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /raise the cap/i });
    expect(link).toHaveAttribute('href', '/settings');
    expect(link).toHaveClass('min-h-11');
  });

  it('never shows during the trial (the trial has its own nudge)', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ kind: 'trial', usedMinutes: 59, includedMinutes: 60 }),
    } as unknown as Response);
    const { container } = renderBanner();
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
