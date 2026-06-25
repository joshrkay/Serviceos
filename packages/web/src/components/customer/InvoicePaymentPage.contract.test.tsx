/**
 * Tenant-neutral class contract for the public invoice payment page (U13c).
 *
 * The Tailwind chrome around the Stripe PaymentElement must carry the Path A
 * neutral recolor with no raw palette and no ServiceOS brand blue. The Stripe
 * iframe itself is intentionally left on its default theme (see the page).
 * Regression tripwire only — the source grep is authoritative.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-elements">{children}</div>
  ),
  PaymentElement: () => <div data-testid="stripe-payment-element">[card fields]</div>,
  useStripe: () => ({ confirmPayment: vi.fn() }),
  useElements: () => ({}),
}));
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn(() => Promise.resolve({})) }));

import { InvoicePaymentPage } from './InvoicePaymentPage';

const invoice = {
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
  return { ok, status, json: async () => body } as Response;
}

function renderPage() {
  vi.spyOn(global, 'fetch').mockImplementation(((input: RequestInfo) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/public-payments/create-payment-intent')) {
      return Promise.resolve(jsonResponse({ clientSecret: 'pi_test_123_secret_abc' }));
    }
    if (url.includes('/view')) return Promise.resolve(jsonResponse({}));
    if (url.includes('/public/invoices/')) return Promise.resolve(jsonResponse(invoice));
    return Promise.resolve(jsonResponse({}, false, 404));
  }) as typeof fetch);
  return render(
    <MemoryRouter initialEntries={['/pay/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']}>
      <Routes>
        <Route path="/pay/:id" element={<InvoicePaymentPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const RAW_PALETTE =
  /(bg|text|border|border-l|border-r|border-t|border-b|placeholder|ring|divide|shadow|from|via|to)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/;

describe('InvoicePaymentPage — tenant-neutral class contract', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders no raw palette and no ServiceOS brand blue once the invoice loads', async () => {
    const { container } = renderPage();
    await screen.findByText('HVAC Pro');
    const html = container.innerHTML;
    expect(html).not.toMatch(RAW_PALETTE);
    expect(html).not.toMatch(/\b(bg|text|border|ring)-primary\b/);
    expect(html).not.toMatch(/\bring-ring\b/);
    expect(html).not.toMatch(/\b(bg|text|border)-accent\b|accent-foreground/);
  });
});
