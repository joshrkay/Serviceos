import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  beforeEach(async () => {
    vi.restoreAllMocks();
    confirmPaymentMock.mockReset();
    // Default: a fake publishable key is configured so loadStripe is
    // invoked and returns a non-null Stripe object. Tests for the
    // missing-key path delete this env entry instead.
    process.env.VITE_STRIPE_PUBLISHABLE_KEY = 'pk_test_unit_test_key';
    const stripeJs = await import('@stripe/stripe-js');
    vi.mocked(stripeJs.loadStripe).mockReturnValue(Promise.resolve({} as never));
  });

  afterEach(() => {
    delete process.env.VITE_STRIPE_PUBLISHABLE_KEY;
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

  it('success — confirmPayment resolving without an error renders the paid screen via setSearchParams (no full reload)', async () => {
    mockFetch({});
    confirmPaymentMock.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'succeeded' } });

    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /pay.*securely/i }));
    fireEvent.click(screen.getByRole('button', { name: /pay.*securely/i }));

    await waitFor(() => {
      expect(confirmPaymentMock).toHaveBeenCalled();
    });
    // After success, react-router's setSearchParams flips us to ?success=true
    // and the same component re-renders the redirect-back paid screen
    // (no `window.location.search =` write, so no full page reload).
    await waitFor(() => {
      expect(screen.getByText(/payment received/i)).toBeInTheDocument();
    });
  });

  it('processing_async — confirmPayment with intent.status=processing shows processing banner, NOT "Payment received"', async () => {
    // Codex P1 fix: ACH / capture-later flows return without an error
    // but the intent is still settling. Don't show success yet.
    mockFetch({});
    confirmPaymentMock.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'processing' } });

    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /pay.*securely/i }));
    fireEvent.click(screen.getByRole('button', { name: /pay.*securely/i }));

    await waitFor(() => expect(confirmPaymentMock).toHaveBeenCalled());
    // Processing banner appears
    await waitFor(() => {
      expect(screen.getByText(/processing with your bank/i)).toBeInTheDocument();
    });
    // Premature "Payment received" must NOT be shown.
    expect(screen.queryByText(/payment received/i)).not.toBeInTheDocument();
  });

  it('processing_async — requires_capture also shows processing banner, not success', async () => {
    mockFetch({});
    confirmPaymentMock.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'requires_capture' } });

    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /pay.*securely/i }));
    fireEvent.click(screen.getByRole('button', { name: /pay.*securely/i }));

    await waitFor(() => {
      expect(screen.getByText(/processing with your bank/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/payment received/i)).not.toBeInTheDocument();
  });

  it('intermediate states — requires_action surfaces a clear "not yet complete" error rather than fake success', async () => {
    mockFetch({});
    confirmPaymentMock.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'requires_action' } });

    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /pay.*securely/i }));
    fireEvent.click(screen.getByRole('button', { name: /pay.*securely/i }));

    await waitFor(() => {
      expect(screen.getByText(/not yet complete/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/payment received/i)).not.toBeInTheDocument();
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

  it('Codex P2: missing publishable key surfaces not-configured fallback (no dead form)', async () => {
    // Without the publishable key on the frontend, loadStripe is never
    // called and stripePromise resolves to null — <Elements> would
    // render a permanently disabled form. We short-circuit BEFORE
    // requesting the intent and show the not-configured fallback
    // (same path as the backend 503).
    delete process.env.VITE_STRIPE_PUBLISHABLE_KEY;
    const fetchSpy = mockFetch({});

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('stripe-not-configured')).toBeInTheDocument();
    });
    // Crucially: the create-payment-intent endpoint was NOT called.
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('create-payment-intent'))).toBe(false);
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
