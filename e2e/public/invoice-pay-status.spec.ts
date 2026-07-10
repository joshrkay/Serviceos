import { test, expect, Page, Route } from '@playwright/test';
import { installClerkStub } from '../helpers/clerk-stub';
import { installStripeStub, setStripeConfirmResult } from '../helpers/stripe-stub';

/**
 * W1-4 — Hermetic public pay page status poll.
 *
 * Proves `/pay/:id` updates payment status **in place** via
 * `useInvoiceStatus` polling (open → paid) without blanking the page.
 *
 * Stripe Elements card entry is intentionally out of scope: we stub
 * `@stripe/*` so confirmPayment can return `processing`, which is the
 * only production path that enables status polling. Real Elements /
 * PaymentIntent confirmation belongs to a later thread (not W1-4).
 *
 * Pattern: gate the second status response and assert mid-flight UI
 * stays mounted (same idea as the invoices list render-stability
 * suite). Avoids `page.clock.install()` before SPA boot.
 */

const hasWebApp =
  !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

const VIEW_TOKEN = 'e2e_pay_status_token_abcdefghijklmnop';
const INVOICE_ID = 'inv_e2e_pay_status_1';

const unpaidInvoice = {
  id: INVOICE_ID,
  invoiceNumber: 'INV-E2E-PAY-1',
  status: 'open',
  customerName: 'Jordan Customer',
  businessName: 'Acme HVAC',
  businessPhone: '+15555550199',
  lineItems: [
    {
      description: 'AC repair',
      quantity: 1,
      unitPriceCents: 42_500,
      totalCents: 42_500,
    },
  ],
  totalCents: 42_500,
  subtotalCents: 42_500,
  taxCents: 0,
  discountCents: 0,
  amountPaidCents: 0,
  amountDueCents: 42_500,
  isPaid: false,
  viewCount: 1,
};

function json(data: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

async function blockExternalHosts(page: Page, baseURL: string): Promise<void> {
  const appOrigin = new URL(baseURL).origin;
  await page.route(
    (url) => url.origin !== appOrigin,
    (route) => route.abort(),
  );
}

test.describe('W1-4 — public /pay/:id status poll (hermetic)', () => {
  test.skip(
    !hasWebApp,
    'Needs VITE_CLERK_PUBLISHABLE_KEY (or E2E_BASE_URL) so the SPA boots. ' +
      'Any syntactically valid pk_test_ works — Clerk is stubbed offline. ' +
      'No Stripe secrets required (Elements stubbed; status poll only).',
  );

  test('polls open → paid in place without blanking mid-poll', async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, 'Playwright baseURL is required');

    await installClerkStub(page, { signedIn: false });
    await installStripeStub(page);
    await blockExternalHosts(page, baseURL!);

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let statusCalls = 0;
    // Install the paid-response gate before any poll can fire so a
    // second tick cannot slip through while we still expect mid-poll UI.
    let releasePaidPoll: (() => void) | null = null;
    let paidPollGate = new Promise<void>((resolve) => {
      releasePaidPoll = resolve;
    });

    await page.route('**/public/invoices/**', async (route: Route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill(json(unpaidInvoice));
        return;
      }
      // /view beacon
      await route.fulfill({ status: 204, body: '' });
    });

    await page.route(
      (url) => url.pathname.startsWith('/api/public-payments'),
      async (route: Route) => {
        const path = new URL(route.request().url()).pathname;
        const method = route.request().method();

        if (method === 'POST' && path.endsWith('/create-payment-intent')) {
          await route.fulfill(
            json({
              clientSecret: 'pi_e2e_stub_secret_abc',
              paymentIntentId: 'pi_e2e_stub',
            }),
          );
          return;
        }

        if (method === 'GET' && path.includes(`/status/${INVOICE_ID}`)) {
          statusCalls += 1;
          if (statusCalls === 1) {
            await route.fulfill(
              json({
                status: 'open',
                amountDueCents: 42_500,
                amountPaidCents: 0,
                paidAt: null,
              }),
            );
            return;
          }
          // Gate the paid response so we can assert mid-poll UI.
          await paidPollGate;
          await route.fulfill(
            json({
              status: 'paid',
              amountDueCents: 0,
              amountPaidCents: 42_500,
              paidAt: '2026-07-10T12:00:00.000Z',
            }),
          );
          return;
        }

        await route.fulfill(json({ error: 'unmocked' }, 404));
      },
    );

    await page.goto(`/pay/${VIEW_TOKEN}`);

    // Initial unpaid/open UI — invoice chrome stays mounted.
    await expect(page.getByText('INV-E2E-PAY-1')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Hi, Jordan/i)).toBeVisible();
    await expect(page.getByText('Amount due')).toBeVisible();
    await expect(page.getByText('$425.00').first()).toBeVisible();
    expect(pageErrors, 'no page errors on first paint').toEqual([]);

    // Stubbed Elements form (not real Stripe) — Pay CTA enters async path.
    await expect(page.getByTestId('stripe-payment-element')).toBeVisible();
    await setStripeConfirmResult(page, {
      paymentIntent: { id: 'pi_e2e_async', status: 'processing' },
    });

    await page.getByRole('button', { name: /pay .* securely/i }).click();

    // processing_async banner — polling starts; first status tick is `open`.
    const processingBanner = page.getByRole('status').filter({
      hasText: /processing with your bank/i,
    });
    await expect(processingBanner).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Payment received/i)).toHaveCount(0);
    await expect.poll(() => statusCalls).toBeGreaterThanOrEqual(1);

    // Second tick fires on the 5s interval (no page.clock — safer for SPA boot)
    // and stays gated until we release — assert mid-poll UI stays mounted.
    await expect.poll(() => statusCalls, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    await expect(processingBanner).toBeVisible();
    await expect(page.getByText('INV-E2E-PAY-1', { exact: true })).toBeVisible();
    // Full-page boot spinner is a lone animate-spin in a min-h-screen flex
    // center — must not replace the processing UI mid-poll.
    await expect(page.locator('.min-h-screen > .animate-spin')).toHaveCount(0);
    await expect(page.getByText(/Payment received/i)).toHaveCount(0);

    releasePaidPoll?.();

    await expect(page.getByRole('heading', { name: 'Payment received!' })).toBeVisible({
      timeout: 10_000,
    });
    // PaidScreen mentions the invoice number in the thank-you copy and the
    // receipt row — pin the receipt row (exact) so strict mode stays happy.
    await expect(page.getByText('INV-E2E-PAY-1', { exact: true })).toBeVisible();
    await expect(page.getByText('Paid', { exact: true })).toBeVisible();
    expect(pageErrors, 'no page errors during status poll → paid').toEqual([]);
  });
});
