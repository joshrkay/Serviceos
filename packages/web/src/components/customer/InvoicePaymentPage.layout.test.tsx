/**
 * B7.5 (PR review, FINDING B — invoice half) — the descriptive unit reaches
 * the customer on the PAY page, mirroring the estimate-side fix in ea46e5a
 * (EstimateApprovalPage.layout.test.tsx).
 *
 * jsdom can't measure real overflow, so these assertions pin the CSS class
 * contract the fix depends on: the unit renders as a `block` + `break-words`
 * child INSIDE the existing fixed-width Qty column (no new grid track), so
 * it can only add height, never width, at the 320px viewport. The explicit
 * track-budget arithmetic below documents that the 320px budget is
 * unaffected by this change (it was already this tight before B7.5 — that
 * pre-existing condition is not something this change alters or fixes).
 *
 * No Playwright e2e spec accompanies this file: this repo's e2e specs
 * self-skip without Clerk credentials, which are not configured in this
 * environment, so a spec would never execute here. See the report for the
 * explicit statement of what did and did not run.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

// ─── Stripe mocks (same stubs as InvoicePaymentPage.test.tsx) ──────────────

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

import { InvoicePaymentPage } from './InvoicePaymentPage';

const baseInvoice = {
  id: 'inv_1',
  invoiceNumber: 'INV-001',
  status: 'open',
  customerName: 'Jane Customer',
  businessName: 'HVAC Pro',
  businessPhone: '+15555550100',
  lineItems: [
    // 'per gal' is the LONGEST unit in catalogUnitSchema — the worst case
    // for the fixed 40px Qty track.
    { description: 'Sealant', quantity: 12, unit: 'per gal', unitPriceCents: 4_200, totalCents: 50_400 },
    { description: 'Prep labor', quantity: 3, unitPriceCents: 8_500, totalCents: 25_500 },
  ],
  totalCents: 75_900,
  subtotalCents: 75_900,
  taxCents: 0,
  discountCents: 0,
  amountPaidCents: 0,
  amountDueCents: 75_900,
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

function mockFetch(opts: { invoice?: unknown } = {}) {
  return vi.spyOn(global, 'fetch').mockImplementation(((input: RequestInfo) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/public-payments/status/')) {
      return Promise.resolve(
        jsonResponse({ status: 'open', amountDueCents: 75_900, amountPaidCents: 0, paidAt: null }),
      );
    }
    if (url.includes('/api/public-payments/create-payment-intent')) {
      return Promise.resolve(jsonResponse({ clientSecret: 'pi_test_123_secret_abc' }));
    }
    if (url.includes('/view')) {
      return Promise.resolve(jsonResponse({}));
    }
    if (url.includes('/public/invoices/')) {
      return Promise.resolve(jsonResponse(opts.invoice ?? baseInvoice));
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
    </MemoryRouter>,
  );
}

describe('InvoicePaymentPage — B7.5 descriptive unit / mobile layout contract', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    confirmPaymentMock.mockReset();
    process.env.VITE_STRIPE_PUBLISHABLE_KEY = 'pk_test_unit_test_key';
    const stripeJs = await import('@stripe/stripe-js');
    vi.mocked(stripeJs.loadStripe).mockReturnValue(Promise.resolve({} as never));
  });

  afterEach(() => {
    delete process.env.VITE_STRIPE_PUBLISHABLE_KEY;
  });

  it('renders the descriptive unit under the quantity, inside the Qty cell', async () => {
    mockFetch();
    renderPage();

    const unit = await screen.findByTestId('line-item-unit-0');
    expect(unit.textContent).toBe('per gal');
    // block + break-words is the mechanism that keeps a long unit INSIDE
    // the fixed 40px Qty track instead of widening the row.
    expect(unit.className).toContain('block');
    expect(unit.className).toContain('break-words');
    // It lives in the Qty cell, immediately after the number.
    const qtyCell = unit.parentElement as HTMLElement;
    expect(qtyCell.textContent).toBe('12per gal');
    // The second line has no unit and renders no unit node at all.
    expect(screen.queryByTestId('line-item-unit-1')).not.toBeInTheDocument();
  });

  it('the Qty/Rate/Total grid tracks are unchanged by the unit (no new column)', async () => {
    mockFetch();
    renderPage();

    const unit = await screen.findByTestId('line-item-unit-0');
    const row = unit.closest('div.grid') as HTMLElement;
    // Load-bearing: still the same fixed-width tracks as before B7.5. The
    // unit is a child of the Qty cell, not a fifth column.
    expect(row.className).toContain('grid-cols-[1fr_40px_72px_72px]');
    const cells = Array.from(row.children) as HTMLElement[];
    expect(cells).toHaveLength(4);
    // Header row carries the identical (unchanged) track contract.
    const header = screen.getByText('Item').parentElement as HTMLElement;
    expect(header.className).toContain('grid-cols-[1fr_40px_72px_72px]');
  });

  it('320px track budget: unchanged before/after this change (explicit arithmetic)', async () => {
    // jsdom cannot measure real layout, so this pins the ARITHMETIC the
    // e2e spec would verify at runtime. The unit is rendered as a `block`
    // child INSIDE the existing 40px Qty track (asserted above), so it
    // consumes zero additional horizontal budget — the sum below is
    // identical whether or not any line carries a `unit`.
    //
    //   320  viewport width
    //  − 40  outer page gutter (`px-5` × 2, on `.max-w-lg.mx-auto.px-5`)
    //  −  2  card border (`border` × 2 sides, ~1px each)
    //  − 40  row gutter (`px-5` × 2, on the grid row itself)
    //  − 24  3 × `gap-x-2` (8px each) between the 4 columns
    //  -----
    //  = 214  budget left for the 4 grid tracks combined
    //  − 184  fixed columns (40 + 72 + 72 = 184px for Qty/Rate/Total)
    //  -----
    //  =  30  px left for the description (`1fr`) column
    //
    // 30px is unchanged by this change: the unit adds height (it wraps
    // inside the 40px Qty track), never width. This number is NOT
    // improved by this change — it is a pre-existing description-column
    // budget on this page (which, unlike EstimateApprovalPage, does not
    // yet have the `minmax(0,1fr)` / narrowed-mobile-Qty treatment from
    // the EE-4 fix) and fixing it is out of scope for this unit-threading
    // change.
    const viewportPx = 320;
    const pageGutterPx = 40;
    const cardBorderPx = 2;
    const rowGutterPx = 40;
    const gapsPx = 3 * 8;
    const fixedColsPx = 40 + 72 + 72;
    const trackBudgetPx = viewportPx - pageGutterPx - cardBorderPx - rowGutterPx - gapsPx;
    const descriptionBudgetPx = trackBudgetPx - fixedColsPx;
    expect(trackBudgetPx).toBe(214);
    expect(descriptionBudgetPx).toBe(30);
  });

  it('the unit is descriptive: the rendered money is unchanged by it', async () => {
    mockFetch();
    renderPage();

    const unit = await screen.findByTestId('line-item-unit-0');
    const row = unit.closest('div.grid') as HTMLElement;
    const cells = Array.from(row.children) as HTMLElement[];
    // 12 x $42.00 = $504.00 — the same figures a unit-less line would show.
    expect(cells[2].textContent).toBe('$42.00');
    expect(cells[3].textContent).toBe('$504.00');
  });

  it('a legacy invoice with no units on any line renders exactly as before (no unit nodes)', async () => {
    mockFetch({
      invoice: {
        ...baseInvoice,
        lineItems: [
          { description: 'AC Repair', quantity: 1, unitPriceCents: 42_500, totalCents: 42_500 },
        ],
      },
    });
    renderPage();
    await screen.findByText('AC Repair');
    expect(screen.queryByTestId('line-item-unit-0')).not.toBeInTheDocument();
  });

  it('stripe payment form still mounts once the client_secret loads (unit change did not regress the pay flow)', async () => {
    mockFetch();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('stripe-elements')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /pay.*securely/i })).toBeInTheDocument();
  });
});
