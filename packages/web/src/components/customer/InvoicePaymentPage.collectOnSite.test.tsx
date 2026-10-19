/**
 * S5a-2 (U8) — the public invoice page honours the payment choice the owner
 * made on the "When a job's done, how do you want to get paid?" card.
 *
 * The API decides the policy (`GET /public/invoices/:token` carries
 * `paymentCollectionMode`, fail-closed to `unavailable` when it cannot read
 * it); this page only obeys it: no card form, no PaymentIntent request, and a
 * plain note with a glove-sized call link instead. HTTP is mocked at the
 * fetch boundary (as InvoicePaymentPage.layout.test.tsx does); the Stripe SDK
 * is stubbed so a mounted form would be visible as `stripe-payment-element`.
 *
 * jsdom cannot measure, so the 44px/320px contract is pinned here by class
 * and measured on the real stack in e2e/invoice-payment-collect-on-site.spec.ts.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('@stripe/react-stripe-js', () => {
  const Elements = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-elements">{children}</div>
  );
  const PaymentElement = () => <div data-testid="stripe-payment-element">[card fields]</div>;
  const useStripe = () => ({ confirmPayment: vi.fn() });
  const useElements = () => ({});
  return { Elements, PaymentElement, useStripe, useElements };
});

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(() => Promise.resolve({})),
}));

import { InvoicePaymentPage } from './InvoicePaymentPage';

const baseInvoice = {
  id: 'inv_1',
  invoiceNumber: 'INV-001',
  status: 'open',
  customerName: 'Jane Customer',
  businessName: 'Acme HVAC',
  businessPhone: '+15555550100',
  lineItems: [{ description: 'Service call', quantity: 1, unitPriceCents: 12_500, totalCents: 12_500 }],
  totalCents: 12_500,
  subtotalCents: 12_500,
  taxCents: 0,
  discountCents: 0,
  amountPaidCents: 0,
  amountDueCents: 12_500,
  isPaid: false,
  viewCount: 1,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

function mockFetch(invoice: Record<string, unknown>) {
  const intentCalls: string[] = [];
  const spy = vi.spyOn(global, 'fetch').mockImplementation(((input: RequestInfo) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/public-payments/create-payment-intent')) {
      intentCalls.push(url);
      return Promise.resolve(jsonResponse({ clientSecret: 'pi_test_123_secret_abc' }));
    }
    if (url.includes('/api/public-payments/status/')) {
      return Promise.resolve(jsonResponse({ status: 'open', amountDueCents: 12_500, amountPaidCents: 0, paidAt: null }));
    }
    if (url.endsWith('/view')) return Promise.resolve(jsonResponse({}));
    if (url.includes('/public/invoices/')) return Promise.resolve(jsonResponse(invoice));
    return Promise.resolve(jsonResponse({}, false, 404));
  }) as typeof fetch);
  return { spy, intentCalls };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/pay/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']}>
      <Routes>
        <Route path="/pay/:id" element={<InvoicePaymentPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Lets every pending fetch/effect settle so an intent request would have fired. */
async function settle() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });
}

describe('InvoicePaymentPage — honours the payment choice (S5a-2, U8)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.VITE_STRIPE_PUBLISHABLE_KEY = 'pk_test_unit_test_key';
    const stripeJs = await import('@stripe/stripe-js');
    vi.mocked(stripeJs.loadStripe).mockReturnValue(Promise.resolve({} as never));
  });

  afterEach(() => {
    delete process.env.VITE_STRIPE_PUBLISHABLE_KEY;
  });

  it('collect_on_site: no card form, no payment request, the in-person note and a 44px call link', async () => {
    const { intentCalls } = mockFetch({ ...baseInvoice, paymentCollectionMode: 'collect_on_site' });
    renderPage();

    const note = await screen.findByTestId('pay-in-person');
    expect(note.textContent).toContain('Acme HVAC collects payment in person. Settle up when the work is done.');
    // The totals still show: the customer still knows what is owed.
    expect(screen.getAllByText('$125.00').length).toBeGreaterThan(0);

    const call = screen.getByTestId('pay-in-person-call');
    expect(call).toHaveAttribute('href', 'tel:+15555550100');
    expect(call.className).toContain('min-h-11');
    expect(call.textContent).toContain('Call Acme HVAC');

    await settle();
    expect(intentCalls).toHaveLength(0);
    expect(screen.queryByTestId('stripe-payment-element')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-form-loading')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay \$/ })).not.toBeInTheDocument();
    // No card-form promises on a page with no card form.
    expect(screen.queryByText(/Powered by Stripe/)).not.toBeInTheDocument();
  });

  it('collect_on_site wins over a missing publishable key (no "temporarily unavailable" box)', async () => {
    delete process.env.VITE_STRIPE_PUBLISHABLE_KEY;
    mockFetch({ ...baseInvoice, paymentCollectionMode: 'collect_on_site' });
    renderPage();

    await screen.findByTestId('pay-in-person');
    expect(screen.queryByTestId('stripe-not-configured')).not.toBeInTheDocument();
  });

  it('collect_on_site with no phone on file: the note, and no call link', async () => {
    const { businessPhone: _omit, ...noPhone } = baseInvoice;
    mockFetch({ ...noPhone, paymentCollectionMode: 'collect_on_site' });
    renderPage();

    await screen.findByTestId('pay-in-person');
    expect(screen.queryByTestId('pay-in-person-call')).not.toBeInTheDocument();
  });

  it('unavailable: no card form, no payment request, the try-again copy and the call link', async () => {
    const { intentCalls } = mockFetch({ ...baseInvoice, paymentCollectionMode: 'unavailable' });
    renderPage();

    const note = await screen.findByTestId('pay-unavailable');
    expect(note.textContent).toContain("Online payment isn't available right now.");
    expect(note.textContent).toContain('try again in a moment');
    // Never the in-person promise: the owner's choice could not be read.
    expect(note.textContent).not.toContain('collects payment in person');

    const call = screen.getByTestId('pay-unavailable-call');
    expect(call).toHaveAttribute('href', 'tel:+15555550100');
    expect(call.className).toContain('min-h-11');

    await settle();
    expect(intentCalls).toHaveLength(0);
    expect(screen.queryByTestId('stripe-payment-element')).not.toBeInTheDocument();
  });

  it('pay_link: the card form renders as before', async () => {
    const { intentCalls } = mockFetch({ ...baseInvoice, paymentCollectionMode: 'pay_link' });
    renderPage();

    expect(await screen.findByTestId('stripe-payment-element')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay \$125\.00 securely/ })).toBeInTheDocument();
    expect(intentCalls).toHaveLength(1);
    expect(screen.queryByTestId('pay-in-person')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pay-unavailable')).not.toBeInTheDocument();
  });

  it('an older API that sends no mode: treated as pay_link on the web (form renders)', async () => {
    const { intentCalls } = mockFetch({ ...baseInvoice });
    renderPage();

    expect(await screen.findByTestId('stripe-payment-element')).toBeInTheDocument();
    await waitFor(() => expect(intentCalls).toHaveLength(1));
  });

  it('a paid invoice still shows the paid screen whatever the mode', async () => {
    mockFetch({ ...baseInvoice, paymentCollectionMode: 'collect_on_site', isPaid: true, amountDueCents: 0, amountPaidCents: 12_500 });
    renderPage();

    expect(await screen.findByText('Payment received!')).toBeInTheDocument();
    expect(screen.queryByTestId('pay-in-person')).not.toBeInTheDocument();
  });
});
