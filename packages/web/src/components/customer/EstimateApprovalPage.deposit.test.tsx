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

describe('EstimateApprovalPage — Tier 4 deposit (PR 3b: before_approval gate + Pay deposit CTA)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows the Pay deposit CTA in place of Approve when before_approval and unpaid', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return jsonResponse({
          ...baseView,
          depositRequiredCents: 25000,
          depositStatus: 'pending',
          depositTimingPolicy: 'before_approval',
          // Backend marks the estimate non-actionable when before_approval
          // gates approval — page mirrors that gate.
          isActionable: false,
        });
      }
      return jsonResponse({});
    });
    renderPageAtToken('test-token');

    expect(await screen.findByTestId('estimate-pay-deposit-cta')).toBeInTheDocument();
    // The regular Accept CTA must NOT be present when blocked.
    expect(screen.queryByText(/Accept this estimate/i)).not.toBeInTheDocument();
    // Notice copy reflects the policy.
    const notice = screen.getByTestId('estimate-deposit-notice');
    expect(notice).toHaveTextContent(/pay the deposit to unlock/i);
  });

  it('clicking Pay deposit fetches the checkout URL and redirects', async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });

    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return jsonResponse({
          ...baseView,
          depositRequiredCents: 25000,
          depositStatus: 'pending',
          depositTimingPolicy: 'before_approval',
          isActionable: false,
        });
      }
      if (url.includes('/deposit-checkout')) {
        return jsonResponse({ url: 'https://checkout.stripe.com/c/plink_x' });
      }
      return jsonResponse({});
    });
    renderPageAtToken('test-token');

    const cta = await screen.findByTestId('estimate-pay-deposit-cta');
    cta.click();

    await waitFor(() =>
      expect(assignSpy).toHaveBeenCalledWith('https://checkout.stripe.com/c/plink_x'),
    );
  });

  it('after_approval policy keeps the Accept CTA even when a deposit is required', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return jsonResponse({
          ...baseView,
          depositRequiredCents: 25000,
          depositStatus: 'pending',
          depositTimingPolicy: 'after_approval',
          isActionable: true,
        });
      }
      return jsonResponse({});
    });
    renderPageAtToken('test-token');

    expect(await screen.findByText(/Accept this estimate/i)).toBeInTheDocument();
    expect(screen.queryByTestId('estimate-pay-deposit-cta')).not.toBeInTheDocument();
  });
});
