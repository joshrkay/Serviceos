import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { EstimateApprovalPage } from './EstimateApprovalPage';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const baseView = {
  id: 'est-1',
  estimateNumber: 'EST-1042',
  status: 'sent',
  customerName: 'Sarah Johnson',
  businessName: 'Acme HVAC',
  lineItems: [
    { description: 'AC tune-up', quantity: 1, unitPriceCents: 12500, totalCents: 12500 },
  ],
  totalCents: 12500,
  subtotalCents: 12500,
  taxCents: 0,
  discountCents: 0,
  isActionable: true,
  isExpired: false,
  depositRequiredCents: 0,
  depositPaidCents: 0,
  depositStatus: 'not_required',
};

/** ISO string `days` from now (negative for the past). */
function isoInDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function mockView(view: Record<string, unknown>) {
  apiFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) return jsonResponse(view);
    return jsonResponse({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/e/test-token']}>
      <Routes>
        <Route path="/e/:id" element={<EstimateApprovalPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EstimateApprovalPage — validity urgency banner (Hennessy)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows a countdown when the quote is held for a few more days', async () => {
    mockView({ ...baseView, validUntil: isoInDays(3) });
    renderPage();
    const banner = await screen.findByTestId('estimate-validity-banner');
    expect(banner).toHaveTextContent(/3 days left/i);
  });

  it('uses the singular "1 day left / tomorrow" copy at the deadline', async () => {
    mockView({ ...baseView, validUntil: isoInDays(1) });
    renderPage();
    const banner = await screen.findByTestId('estimate-validity-banner');
    expect(banner).toHaveTextContent(/tomorrow/i);
  });

  it('omits the day-count once the window is comfortably far out', async () => {
    mockView({ ...baseView, validUntil: isoInDays(45) });
    renderPage();
    const banner = await screen.findByTestId('estimate-validity-banner');
    expect(banner).toHaveTextContent(/held until/i);
    expect(banner).not.toHaveTextContent(/days left/i);
  });

  it('renders no banner when the quote carries no validUntil', async () => {
    mockView({ ...baseView });
    renderPage();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('estimate-validity-banner')).not.toBeInTheDocument();
  });

  it('suppresses the banner on an expired estimate (the expired notice owns that)', async () => {
    mockView({ ...baseView, isExpired: true, validUntil: isoInDays(-2) });
    renderPage();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('estimate-validity-banner')).not.toBeInTheDocument();
  });
});
