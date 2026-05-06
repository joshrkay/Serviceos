import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// EstimateApprovalPage uses several toast/sonner imports; stub to avoid cross-talk.
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

function renderPageAtToken(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/e/${token}`]}>
      <Routes>
        <Route path="/e/:id" element={<EstimateApprovalPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EstimateApprovalPage — Tier 4 deposit notice (PR 3a)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('renders the deposit notice when depositRequiredCents > 0', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      // First call: GET — returns the view with deposit info.
      if (!init || init.method === undefined) {
        return jsonResponse({
          ...baseView,
          depositRequiredCents: 25000,
          depositStatus: 'pending',
        });
      }
      return jsonResponse({});
    });
    renderPageAtToken('test-token');
    const notice = await screen.findByTestId('estimate-deposit-notice');
    expect(notice).toHaveTextContent(/Deposit required to confirm/i);
    expect(notice).toHaveTextContent('$250.00');
    expect(notice).toHaveTextContent(/prompted to pay the deposit/i);
  });

  it('shows a "Paid" pill when depositStatus is paid', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return jsonResponse({
          ...baseView,
          depositRequiredCents: 25000,
          depositPaidCents: 25000,
          depositStatus: 'paid',
        });
      }
      return jsonResponse({});
    });
    renderPageAtToken('test-token');
    const notice = await screen.findByTestId('estimate-deposit-notice');
    expect(notice).toHaveTextContent('Paid');
    expect(notice).toHaveTextContent(/Thanks/i);
  });

  it('does not render the notice when depositRequiredCents is 0', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return jsonResponse(baseView);
      }
      return jsonResponse({});
    });
    renderPageAtToken('test-token');
    // Wait for the page to settle.
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('estimate-deposit-notice')).not.toBeInTheDocument();
  });
});
