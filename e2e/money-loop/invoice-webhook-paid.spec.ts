import { test, expect, type Page } from '@playwright/test';
import * as crypto from 'crypto';

/**
 * W1-2 — Hermetic UI companion: `/pay` shows Paid after a signed-webhook
 * settlement signal, without Stripe Elements/Checkout.
 *
 * CI mode: public `/pay/:token` is route-mocked. A page-local webhook sink
 * verifies Stripe signature shape (same HMAC as
 * `createWebhookSignature` in packages/api) and flips the mock invoice to
 * paid — proving the customer UI path without live Stripe or a DB.
 *
 * Strongest settlement proof (real handler + durable idempotency) is API CI:
 *   - packages/api/test/webhooks/invoice-webhook-paid.test.ts
 *   - packages/api/test/integration/invoice-webhook-paid.test.ts
 *
 * Thread: docs/plans/wave1/W1-2-invoice-webhook-paid.md
 */

const hasClerk = !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

const INVOICE_ID = 'inv-w1-2-e2e';
const VIEW_TOKEN = 'w1-2-e2e-token';
const AMOUNT_CENTS = 50_000;
const STRIPE_SECRET = 'whsec_test_w1_2_e2e';

interface PublicInvoiceView {
  id: string;
  invoiceNumber: string;
  status: string;
  customerName: string;
  businessName: string;
  businessPhone?: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
  }>;
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  isPaid: boolean;
  viewCount: number;
}

function openInvoice(): PublicInvoiceView {
  return {
    id: INVOICE_ID,
    invoiceNumber: 'INV-W1-2-E2E',
    status: 'open',
    customerName: 'Jordan Customer',
    businessName: 'Acme HVAC',
    businessPhone: '+15555550100',
    lineItems: [
      {
        description: 'Service call',
        quantity: 1,
        unitPriceCents: AMOUNT_CENTS,
        totalCents: AMOUNT_CENTS,
      },
    ],
    totalCents: AMOUNT_CENTS,
    subtotalCents: AMOUNT_CENTS,
    taxCents: 0,
    discountCents: 0,
    amountPaidCents: 0,
    amountDueCents: AMOUNT_CENTS,
    isPaid: false,
    viewCount: 1,
  };
}

function paidInvoice(): PublicInvoiceView {
  return {
    ...openInvoice(),
    status: 'paid',
    amountPaidCents: AMOUNT_CENTS,
    amountDueCents: 0,
    isPaid: true,
  };
}

/** Same algorithm as packages/api/src/webhooks/webhook-handler.ts#createWebhookSignature */
function createWebhookSignature(payload: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

function checkoutCompletedEvent(eventId: string): Record<string, unknown> {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { tenant_id: 'tenant-w1-2-e2e', invoice_id: INVOICE_ID },
        amount_total: AMOUNT_CENTS,
        payment_status: 'paid',
        payment_intent: 'pi_w1_2_e2e',
      },
    },
  };
}

async function mockPublicPayApis(
  page: Page,
  state: { invoice: PublicInvoiceView },
): Promise<{
  webhookPosts: Array<{ signature: string | null; body: string; duplicate: boolean }>;
}> {
  const webhookPosts: Array<{ signature: string | null; body: string; duplicate: boolean }> = [];
  const seenEventIds = new Set<string>();

  // Abort Stripe.js / Elements — this thread explicitly skips card UI.
  await page.route('**/*stripe.com/**', (route) => route.abort());
  await page.route('**/js.stripe.com/**', (route) => route.abort());

  await page.route('**/public/invoices/**', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(state.invoice),
      });
      return;
    }
    await route.fulfill({ status: 204, body: '' });
  });

  // PaymentIntent mint must not run for this proof — return not-configured
  // so the page never mounts Elements (open invoice path only).
  await page.route('**/api/public-payments/create-payment-intent', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'STRIPE_NOT_CONFIGURED' }),
    });
  });

  await page.route('**/api/public-payments/status/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: state.invoice.status,
        amountPaidCents: state.invoice.amountPaidCents,
        amountDueCents: state.invoice.amountDueCents,
        paidAt: state.invoice.isPaid ? new Date().toISOString() : null,
      }),
    });
  });

  // Hermetic webhook sink: verify signature shape + event-id idempotency,
  // then flip the mock invoice (UI companion to the real API handler proof).
  await page.route('**/webhooks/stripe', async (route) => {
    const req = route.request();
    const body = req.postData() ?? '';
    const signature = req.headers()['stripe-signature'] ?? null;

    if (!signature) {
      webhookPosts.push({ signature, body, duplicate: false });
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Missing stripe-signature header' }),
      });
      return;
    }

    const parts = signature.split(',');
    const tsPart = parts.find((p) => p.startsWith('t='));
    const sigPart = parts.find((p) => p.startsWith('v1='));
    if (!tsPart || !sigPart) {
      webhookPosts.push({ signature, body, duplicate: false });
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid signature' }),
      });
      return;
    }
    const ts = tsPart.slice(2);
    const provided = sigPart.slice(3);
    const digest = crypto
      .createHmac('sha256', STRIPE_SECRET)
      .update(`${ts}.${body}`)
      .digest('hex');
    if (digest !== provided) {
      webhookPosts.push({ signature, body, duplicate: false });
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid signature' }),
      });
      return;
    }

    let eventId = '';
    try {
      const parsed = JSON.parse(body) as { id?: string };
      eventId = typeof parsed.id === 'string' ? parsed.id : '';
    } catch {
      webhookPosts.push({ signature, body, duplicate: false });
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      });
      return;
    }

    if (eventId && seenEventIds.has(eventId)) {
      webhookPosts.push({ signature, body, duplicate: true });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ received: true, duplicate: true }),
      });
      return;
    }
    if (eventId) seenEventIds.add(eventId);

    if (!state.invoice.isPaid) {
      state.invoice = paidInvoice();
    }
    webhookPosts.push({ signature, body, duplicate: false });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ received: true }),
    });
  });

  return { webhookPosts };
}

test.describe('W1-2 — invoice webhook → paid (hermetic UI)', () => {
  test.skip(
    !hasClerk,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI E2E tests',
  );

  test('signed webhook settles mock invoice; /pay shows Paid without Elements', async ({
    page,
  }) => {
    const state = { invoice: openInvoice() };
    const { webhookPosts } = await mockPublicPayApis(page, state);

    await page.goto(`/pay/${VIEW_TOKEN}`);
    await expect(page.getByText('INV-W1-2-E2E')).toBeVisible();
    await expect(page.getByText('Payment received!')).toHaveCount(0);
    // Open invoice must not mount Elements (production testid).
    await expect(page.getByTestId('stripe-not-configured')).toBeVisible();
    await expect(page.locator('iframe[name^="__privateStripeFrame"]')).toHaveCount(0);

    const event = checkoutCompletedEvent('evt_w1_2_e2e_1');
    const rawBody = JSON.stringify(event);
    const signature = createWebhookSignature(rawBody, STRIPE_SECRET);

    // page.request bypasses page.route — fire from the page so the hermetic
    // webhook sink intercepts (Vite does not proxy /webhooks).
    const webhookRes = await page.evaluate(
      async ({ body, sig }) => {
        const res = await fetch('/webhooks/stripe', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'stripe-signature': sig,
          },
          body,
        });
        return { status: res.status, json: await res.json() };
      },
      { body: rawBody, sig: signature },
    );
    expect(webhookRes.status).toBe(200);
    expect(webhookRes.json).toEqual({ received: true });
    expect(webhookPosts).toHaveLength(1);
    expect(webhookPosts[0].signature).toBeTruthy();
    expect(state.invoice.isPaid).toBe(true);

    // Replay — same event id must be acknowledged as duplicate, invoice stays paid once.
    const replay = await page.evaluate(
      async ({ body, sig }) => {
        const res = await fetch('/webhooks/stripe', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'stripe-signature': sig,
          },
          body,
        });
        return { status: res.status, json: await res.json() };
      },
      { body: rawBody, sig: createWebhookSignature(rawBody, STRIPE_SECRET) },
    );
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ received: true, duplicate: true });
    expect(webhookPosts).toHaveLength(2);
    expect(webhookPosts[1].duplicate).toBe(true);

    await page.reload();
    await expect(page.getByText('Payment received!')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Paid')).toBeVisible();
    // PaidScreen renders the amount twice (thank-you + receipt row).
    await expect(page.getByText('$500.00').first()).toBeVisible();
    await expect(page.getByTestId('stripe-not-configured')).toHaveCount(0);
    await expect(page.locator('iframe[name^="__privateStripeFrame"]')).toHaveCount(0);
  });

  test('unsigned webhook does not flip the invoice to paid', async ({ page }) => {
    const state = { invoice: openInvoice() };
    await mockPublicPayApis(page, state);

    await page.goto(`/pay/${VIEW_TOKEN}`);
    await expect(page.getByText('INV-W1-2-E2E')).toBeVisible();
    await expect(page.getByTestId('stripe-not-configured')).toBeVisible();

    const event = checkoutCompletedEvent('evt_w1_2_e2e_unsigned');
    const unsigned = await page.evaluate(async (body) => {
      const res = await fetch('/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      return { status: res.status };
    }, JSON.stringify(event));
    expect(unsigned.status).toBe(400);
    expect(state.invoice.isPaid).toBe(false);

    await page.reload();
    await expect(page.getByText('Payment received!')).toHaveCount(0);
    await expect(page.getByTestId('stripe-not-configured')).toBeVisible();
  });
});
