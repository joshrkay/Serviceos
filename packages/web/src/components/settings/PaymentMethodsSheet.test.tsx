import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: apiFetchMock,
}));
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => apiFetchMock,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}));

import { PaymentMethodsSheet } from './PaymentMethodsSheet';

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

describe('PaymentMethodsSheet — Tier 4 Payment methods (PR 1)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('renders the not-connected state when no account exists', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        accountId: null,
        status: 'pending',
        chargesEnabled: false,
        payoutsEnabled: false,
      }),
    );
    render(<PaymentMethodsSheet onClose={() => {}} />);
    await screen.findByTestId('payment-methods-not-connected');
    const cta = screen.getByTestId('payment-methods-connect');
    expect(cta).toHaveTextContent('Connect Stripe account');
  });

  it('renders the active state when charges + payouts enabled', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        accountId: 'acct_x',
        status: 'active',
        chargesEnabled: true,
        payoutsEnabled: true,
      }),
    );
    render(<PaymentMethodsSheet onClose={() => {}} />);
    await screen.findByTestId('payment-methods-active');
    expect(screen.getByTestId('payment-methods-disconnect')).toBeInTheDocument();
  });

  it('renders the pending (KYC incomplete) state with continue-setup CTA', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        accountId: 'acct_x',
        status: 'pending',
        chargesEnabled: false,
        payoutsEnabled: false,
      }),
    );
    render(<PaymentMethodsSheet onClose={() => {}} />);
    await screen.findByTestId('payment-methods-pending');
    const cta = screen.getByTestId('payment-methods-connect');
    expect(cta).toHaveTextContent('Continue Stripe setup');
  });

  it('renders the restricted state when Stripe pauses the account', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        accountId: 'acct_x',
        status: 'restricted',
        chargesEnabled: false,
        payoutsEnabled: false,
      }),
    );
    render(<PaymentMethodsSheet onClose={() => {}} />);
    await screen.findByTestId('payment-methods-restricted');
  });

  it('clicking Connect POSTs onboarding and redirects to Stripe', async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        assign: assignSpy,
        origin: 'https://app.example.com',
      },
    });
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        accountId: null, status: 'pending', chargesEnabled: false, payoutsEnabled: false,
      }),
    );
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ url: 'https://connect.stripe.com/setup/acct_test', accountId: 'acct_test' }),
    );

    render(<PaymentMethodsSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('payment-methods-connect'));
    await waitFor(() =>
      expect(assignSpy).toHaveBeenCalledWith('https://connect.stripe.com/setup/acct_test'),
    );

    const postCall = apiFetchMock.mock.calls.find(
      (c) => c[0] === '/api/billing/connect/onboarding',
    );
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.returnUrl).toBe('https://app.example.com/settings?stripe_connect=1');
    expect(body.refreshUrl).toBe('https://app.example.com/settings?stripe_connect=1');
  });

  it('clicking Disconnect DELETEs and flips status', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        accountId: 'acct_x', status: 'active',
        chargesEnabled: true, payoutsEnabled: true,
      }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ disconnected: true }));

    render(<PaymentMethodsSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('payment-methods-disconnect'));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Stripe Connect disconnected');
    });
    // Connect CTA reappears since status is now disconnected.
    await screen.findByTestId('payment-methods-connect');
  });

  it('surfaces an error toast when onboarding fails', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        accountId: null, status: 'pending', chargesEnabled: false, payoutsEnabled: false,
      }),
    );
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(
        { message: 'Stripe Connect is not configured' },
        { ok: false, status: 503 },
      ),
    );

    render(<PaymentMethodsSheet onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('payment-methods-connect'));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Stripe Connect is not configured');
    });
  });
});
