import { test, expect } from '@playwright/test';

/**
 * Journey 3 — Invoice is sent and paid via Stripe.
 *
 * Why this matters:
 *   This is the "did we actually get the money" path — the one that
 *   converts ServiceOS from a tool into revenue. Covers: invoice approval,
 *   Stripe payment link generation, customer-facing payment page,
 *   Stripe webhook reconciliation, invoice status flips to paid.
 *
 * Current status: SKIPPED.
 *
 * To enable this test we need:
 *   1. Everything Journey 1 + 2 need
 *   2. Stripe test-mode keys in CI (STRIPE_API_KEY, STRIPE_WEBHOOK_SECRET)
 *   3. An approved invoice fixture — either seeded, or executed end-to-end
 *      via Journey 2 as a prerequisite
 *   4. Stripe CLI forwarding webhooks to the local API during the test,
 *      OR direct HTTP POST to the webhook endpoint with a valid test
 *      signature (packages/api/test/webhooks/ has the signing helper)
 *   5. P5-016 closed — the InvoicePaymentPage currently uses a setTimeout
 *      fake instead of real Stripe Elements. Fix that before this test
 *      can run the real UI path. As a stopgap, this test can skip the
 *      Elements UI and drive the webhook directly.
 */

test.describe('Journey 3 — invoice to Stripe payment', () => {
  test.skip('approved invoice generates payment link and marks paid on webhook', async ({
    page,
  }) => {
    // Preconditions: authed tenant owner, approved invoice exists.
    // TODO: fixture / call Journey 2 as setup.

    const invoiceId = 'e2e-test-invoice-id';

    // 1. Open the invoice detail page and confirm the Stripe payment link
    //    was generated server-side (P5-010D).
    await page.goto(`/invoices/${invoiceId}`);
    const paymentLink = await page.getByTestId('stripe-payment-link').getAttribute('href');
    expect(paymentLink).toMatch(/^https:\/\/(buy|checkout)\.stripe\.com/);

    // 2. Simulate the customer clicking the payment link and paying.
    //    We do NOT drive the Stripe-hosted page in E2E (brittle + slow).
    //    Instead, fire the `charge.succeeded` webhook directly.
    const webhookRes = await page.request.post('/webhooks/stripe', {
      // Proper Stripe signature construction lives in
      // packages/api/src/payments/stripe-webhook-handler.ts — use the
      // test helper when enabling this.
      headers: {
        'stripe-signature': 'TODO-real-test-signature',
      },
      data: {
        type: 'charge.succeeded',
        data: {
          object: {
            metadata: { invoiceId },
            amount: 50000, // cents
            currency: 'usd',
          },
        },
      },
    });
    expect(webhookRes.status()).toBe(200);

    // 3. Invoice status should now be 'paid'.
    await page.reload();
    await expect(page.getByText(/paid/i)).toBeVisible({ timeout: 10_000 });

    // 4. API sanity check.
    const invRes = await page.request.get(`/api/invoices/${invoiceId}`);
    const invoice = await invRes.json();
    expect(invoice.status).toBe('paid');
    expect(invoice.paidAmountCents).toBe(50000);
  });
});
