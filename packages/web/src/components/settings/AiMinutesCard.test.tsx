/**
 * AiMinutesCard — the AI answering minutes line on Settings plus the
 * owner's overage cap control. Mocks apiFetch for GET /api/billing/ai-usage
 * and PUT /api/billing/ai-overage-cap; asserts on the DOM.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiMinutesCard } from './AiMinutesCard';

const apiFetchMock = vi.fn();

vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PERIOD_USAGE = {
  kind: 'period',
  planId: 'starter',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  usedMinutes: 25,
  includedMinutes: 20,
  overageMinutes: 5,
  overageCentsPerMinute: 125,
  projectedChargeCents: 625,
  capCents: 7_900,
};

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('AiMinutesCard', () => {
  it("shows this period's minutes, the overage rate and the projected charge", async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(PERIOD_USAGE));

    render(<AiMinutesCard canManage />);

    expect(await screen.findByText('25 of 20 AI minutes used')).toBeInTheDocument();
    expect(screen.getByText('5 extra minutes at $1.25/min · $6.25 so far this period')).toBeInTheDocument();
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/billing/ai-usage');
  });

  it('shows trial minutes against the trial allowance', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ kind: 'trial', planId: 'starter', usedMinutes: 45, includedMinutes: 60 }),
    );

    render(<AiMinutesCard canManage />);

    expect(await screen.findByText('45 of 60 trial AI minutes used')).toBeInTheDocument();
    expect(screen.queryByLabelText(/overage cap/i)).not.toBeInTheDocument();
  });

  it('lets the owner raise the cap in dollars and saves it in cents', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(PERIOD_USAGE))
      .mockResolvedValueOnce(jsonResponse({ capCents: 20_000 }));

    render(<AiMinutesCard canManage />);

    const input = await screen.findByLabelText(/monthly overage cap/i);
    expect(input).toHaveValue(79);
    fireEvent.change(input, { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: /save cap/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(apiFetchMock.mock.calls[1][0]).toBe('/api/billing/ai-overage-cap');
    expect(apiFetchMock.mock.calls[1][1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(apiFetchMock.mock.calls[1][1].body)).toEqual({ capCents: 20_000 });
  });

  it('lets the owner remove the cap', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(PERIOD_USAGE))
      .mockResolvedValueOnce(jsonResponse({ capCents: null }));

    render(<AiMinutesCard canManage />);

    fireEvent.click(await screen.findByRole('button', { name: /remove cap/i }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(apiFetchMock.mock.calls[1][1].body)).toEqual({ capCents: null });
  });

  it('hides the cap control from non-owners', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(PERIOD_USAGE));

    render(<AiMinutesCard canManage={false} />);

    expect(await screen.findByText('25 of 20 AI minutes used')).toBeInTheDocument();
    expect(screen.queryByLabelText(/overage cap/i)).not.toBeInTheDocument();
  });

  it('keeps tap targets at least 44px (min-h-11)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(PERIOD_USAGE));

    render(<AiMinutesCard canManage />);

    expect(await screen.findByRole('button', { name: /save cap/i })).toHaveClass('min-h-11');
    expect(screen.getByRole('button', { name: /remove cap/i })).toHaveClass('min-h-11');
    expect(screen.getByLabelText(/monthly overage cap/i)).toHaveClass('min-h-11');
  });
});
