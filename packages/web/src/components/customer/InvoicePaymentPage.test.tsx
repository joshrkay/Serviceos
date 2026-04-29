import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

// ─── Stripe mocks ──────────────────────────────────────────────────────────
//
// The real @stripe/react-stripe-js + @stripe/stripe-js libraries hit
// js.stripe.com and require a publishable key, neither of which we want
// in unit tests. We replace them with stubs that:
//   • render <PaymentElement /> as a recognisable placeholder
//   • return a fake `stripe` from useStripe() so confirmPayment can be
//     spied on per-test
//   • return a non-null `elements` from useElements() so the form's
//     "stripe + elements" guard passes

const confirmPaymentMock = vi.fn();

vi.mock('@stripe/react-stripe-js', () => {
  const Elements = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-elements">{children}</div>
  );
  const PaymentElement = () => <div data-testid="stripe-payment-element">[card fields]</div>;
  const useStripe = () => ({ confirmPayment: confirmPaymentMock });
  const useElements = () => ({});
  return { Elements, PaymentElement, useStripe, useElements };
});

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(() => Promise.resolve({})),
}));

// Now import the page (after mocks are in place).
import { InvoicePaymentPage } from './InvoicePaymentPage';

const baseInvoice = {
  id: 'inv_1',
  invoiceNumber: 'INV-001',
  status: 'open',
  customerName: 'Jane Customer',
  businessName: 'HVAC Pro',
  businessPhone: '+15555550100',
  lineItems: [{ description: 'AC Repair', quantity: 1, unitPriceCents: 42500, totalCents: 42500 }],
  totalCents: 42500,
  subtotalCents: 42500,
  taxCents: 0,
  discountCents: 0,
  amountPaidCents: 0,
  amountDueCents: 42500,
  isPaid: false,
  viewCount: 1,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

/**
 * Wire `fetch` so it returns `invoice` for GET /public/invoices/:t,
 * a no-op for the view ping, and the supplied `intentResponse` for
 * POST /api/public-payments/create-payment-intent.
 */
function mockFetch(opts: {
  invoice?: unknown;
  invoiceOk?: boolean;
  intentResponse?: { ok: boolean; status?: number; body: unknown };
}) {
  return vi.spyOn(global, 'fetch').mockImplementation(((input: RequestInfo) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/public-payments/create-payment-intent')) {
      const r = opts.intentResponse ?? {
        ok: true,
        status: 200,
        body: { clientSecret: 'pi_test_123_secret_abc' },
      };
      return Promise.resolve(jsonResponse(r.body, r.ok, r.status ?? (r.ok ? 200 : 400)));
    }
    if (url.includes('/view')) {
      return Promise.resolve(jsonResponse({}));
    }
    if (url.includes('/public/invoices/')) {
      return Promise.resolve(jsonResponse(opts.invoice ?? baseInvoice, opts.invoiceOk ?? true));
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  }) as typeof fetch);
}

function renderPage(path = '/pay/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/pay/:id" element={<InvoicePaymentPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('P5-016 InvoicePaymentPage — Stripe Elements integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    confirmPaymentMock.mockReset();
  });

  it('happy path — Stripe Elements wraps the payment form once the client_secret loads', async () => {
    mockFetch({});
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('stripe-elements')).toBeInTheDocument();
    });
    expect(screen.getByTestId('stripe-payment-element')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay.*securely/i })).toBeInTheDocument();
  });

  it('success — confirmPayment resolving without an error sets ?success=true', async () => {
    mockFetch({});
    confirmPaymentMock.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'succeeded' } });

    // jsdom location: stub the search setter so we can observe it.
    const setSearchSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        origin: 'http://localhost',
        pathname: '/pay/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        get search() { return ''; },
        set search(v: string) { setSearchSpy(v); },
      },
    });

    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /pay.*securely/i }));
    fireEvent.click(screen.getByRole('button', { name: /pay.*securely/i }));

    await waitFor(() => {
      expect(confirmPaymentMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(setSearchSpy).toHaveBeenCalledWith('?success=true');
    });
  });

  it('failure — confirmPayment returning an error renders the error message', async () => {
    mockFetch({});
    confirmPaymentMock.mockResolvedValue({ error: { message: 'Your card was declined.' } });

    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /pay.*securely/i }));
    fireEvent.click(screen.getByRole('button', { name: /pay.*securely/i }));

    await waitFor(() => {
      expect(screen.getByText('Your card was declined.')).toBeInTheDocument();
    });
  });

  it('mock mode — when backend returns STRIPE_NOT_CONFIGURED, falls back gracefully', async () => {
    mockFetch({
      intentResponse: {
        ok: false,
        status: 503,
        body: { error: 'STRIPE_NOT_CONFIGURED', message: 'not configured' },
      },
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('stripe-not-configured')).toBeInTheDocument();
    });
    // No Stripe Elements wrapper rendered in this branch.
    expect(screen.queryByTestId('stripe-elements')).not.toBeInTheDocument();
  });

  it('still shows the paid screen when invoice is already paid (no PaymentIntent fetched)', async () => {
    const fetchSpy = mockFetch({
      invoice: { ...baseInvoice, isPaid: true, amountPaidCents: 42500, amountDueCents: 0 },
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Payment received!')).toBeInTheDocument();
    });
    // Verify we never called the create-payment-intent endpoint for paid invoices.
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('create-payment-intent'))).toBe(false);
  });

  it('mobile — payment form renders inside a responsive max-w-lg container', async () => {
    mockFetch({});
    const { container } = renderPage();
    await waitFor(() => screen.getByTestId('stripe-elements'));
    // The page wraps content in `max-w-lg` for mobile-first responsive layout.
    expect(container.querySelector('.max-w-lg')).not.toBeNull();
  });

  it('shows Stripe redirect-back paid screen when ?success=true is in the URL', async () => {
    mockFetch({});
    renderPage('/pay/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?success=true');

    await waitFor(() => {
      expect(screen.getByText('Payment received!')).toBeInTheDocument();
    });
  });
});
