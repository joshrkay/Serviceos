import { Page, APIRequestContext } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 8.4 — rung-5 reachability: the customer pays a payable invoice from the
 * link the owner issued, from a public page with no login, at real
 * Postgres. The hosted Stripe checkout itself cannot be driven hermetically
 * (it is a real Stripe-hosted redirect page), so this proves everything up
 * to and including that boundary — the link mint guard, the public page
 * reflecting it, and the embedded Pay control rendering — then settles the
 * invoice the same way test/integration/invoice-webhook-paid.test.ts does:
 * a SIGNED `checkout.session.completed` webhook straight to the real API.
 *
 * Bootstrap pattern mirrors e2e/journeys/digest-toggle.spec.ts /
 * e2e/journeys/public-estimate-approve-sign.spec.ts. All setup goes through
 * the real authenticated API — no SQL, no platform-admin route, no env-var
 * shortcut except STRIPE_WEBHOOK_SECRET, which is exactly the credential a
 * real tenant's own Stripe webhook endpoint configuration would set (see
 * docs/runbooks/stripe-go-live.md) — passed to the API webServer process
 * the same way DATABASE_URL is, per docs/testing-strategy.md.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

// Must match the STRIPE_WEBHOOK_SECRET passed to `npx playwright test` on the
// command line (see docs/audit/lane-reports/public-surfaces-r5.md) — the API
// webServer process reads it from `process.env` at Playwright config load
// time, same mechanism as DATABASE_URL. Deliberately NO in-spec fallback:
// unlike CLERK_WEBHOOK_SECRET (whose default is ALSO baked into
// playwright.config.ts's apiWebServerEnv, so test and server always agree),
// a fallback here would only apply inside this test worker — the webServer
// would still boot with STRIPE_WEBHOOK_SECRET unset, and the signed webhook
// would 401 against a secret the API was never configured with. The `canRun`
// gate below skips instead of false-failing when the var is missing.
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/public-surfaces-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    sub,
    sid: 'dev-session',
    role: 'owner',
  })}.x`;
}

function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${sig}`;
}

/** Stripe-shaped webhook signature — same recipe as createWebhookSignature
 * in packages/api/src/webhooks/webhook-handler.ts. */
function stripeSignature(rawBody: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

interface Tenant {
  tenantId: string;
  authHeaders: { Authorization: string };
}

async function bootstrapOwner(
  request: APIRequestContext,
  label: string,
  businessName: string,
): Promise<Tenant> {
  const ownerSub = `user_e2e_paylink_${label}_${randomUUID().replace(/-/g, '')}`;
  const ownerEmail = `owner-${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(ownerSub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({
    type: 'user.created',
    data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
  });
  const webhookRes = await request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
  expect(webhookRes.status(), `webhook rejected: ${await webhookRes.text()}`).toBe(200);

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, authHeaders };
}

interface PayableInvoice {
  invoiceId: string;
  viewToken: string;
  totalCents: number;
}

async function seedPayableInvoice(
  request: APIRequestContext,
  tenant: Tenant,
  customerLabel: string,
  totalCents: number,
): Promise<PayableInvoice> {
  const customerRes = await request.post(`${API_URL}/api/customers`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      firstName: customerLabel,
      lastName: 'Customer',
      email: `${customerLabel.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`,
      preferredChannel: 'email',
    }),
  });
  expect(customerRes.ok(), `create customer -> ${customerRes.status()}`).toBeTruthy();
  const customer = (await customerRes.json()) as { id: string };

  const locationRes = await request.post(`${API_URL}/api/locations`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      customerId: customer.id,
      street1: '1 Pay From A Link Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      isPrimary: true,
    }),
  });
  expect(locationRes.ok(), `create location -> ${locationRes.status()}`).toBeTruthy();
  const location = (await locationRes.json()) as { id: string };

  const jobRes = await request.post(`${API_URL}/api/jobs`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      customerId: customer.id,
      locationId: location.id,
      summary: `${customerLabel} — 8.4 pay-from-link journey`,
    }),
  });
  expect(jobRes.ok(), `create job -> ${jobRes.status()}`).toBeTruthy();
  const job = (await jobRes.json()) as { id: string };

  const invoiceRes = await request.post(`${API_URL}/api/invoices`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      jobId: job.id,
      lineItems: [
        {
          id: randomUUID(),
          description: 'Service call',
          quantity: 1,
          unitPriceCents: totalCents,
          totalCents,
          sortOrder: 0,
          taxable: false,
        },
      ],
    }),
  });
  expect(invoiceRes.ok(), `create invoice -> ${invoiceRes.status()}`).toBeTruthy();
  const invoice = (await invoiceRes.json()) as { id: string };

  const issueRes = await request.post(`${API_URL}/api/invoices/${invoice.id}/issue`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({}),
  });
  expect(issueRes.ok(), `issue invoice -> ${issueRes.status()} ${await issueRes.text()}`).toBeTruthy();

  const sendRes = await request.post(`${API_URL}/api/invoices/${invoice.id}/send`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({ channel: 'email' }),
  });
  expect(sendRes.ok(), `send invoice -> ${sendRes.status()} ${await sendRes.text()}`).toBeTruthy();
  const sent = (await sendRes.json()) as { viewToken: string };
  expect(sent.viewToken).toBeTruthy();

  return { invoiceId: invoice.id, viewToken: sent.viewToken, totalCents };
}

/** RLS-scoped read against real Postgres, mirroring e2e/qa-matrix/helpers/rw-db.ts. */
async function queryAsTenant(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenantId.replace(/'/g, "''")}'`);
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res.rows;
  } finally {
    await client.end().catch(() => undefined);
  }
}

test.describe('pay from a link (8.4) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!STRIPE_WEBHOOK_SECRET;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), STRIPE_WEBHOOK_SECRET (must be set before ' +
      '`npx playwright test` starts — the API webServer reads it at config-load time), and ' +
      'E2E_USE_TEST_DB=true with DATABASE_URL pointing at the test container.',
  );
  test.use({ viewport: { width: 390, height: 844 } });

  test('an owner issues a payment link, the customer sees the Pay control, and a signed checkout webhook settles the invoice; a neighbour tenant is untouched', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: the invoice under test ────────────────────────────────────
    const tenantA = await bootstrapOwner(request, 'a', 'Acme HVAC 8.4');
    const invoiceA = await seedPayableInvoice(request, tenantA, 'Jordan', 50_000);

    // ── Tenant B: a wholly independent, untouched invoice ───────────────────
    const tenantB = await bootstrapOwner(request, 'b', 'Bexar Plumbing 8.4');
    const invoiceB = await seedPayableInvoice(request, tenantB, 'Sam', 12_000);

    // ── Owner issues the payment link on a payable invoice ──────────────────
    const linkRes1 = await request.post(`${API_URL}/api/invoices/${invoiceA.invoiceId}/payment-link`, {
      headers: tenantA.authHeaders,
    });
    expect(linkRes1.ok(), `payment-link -> ${linkRes1.status()} ${await linkRes1.text()}`).toBeTruthy();
    const link1 = (await linkRes1.json()) as { url: string };
    expect(link1.url).toBeTruthy();

    // Re-issuing on the SAME (still payable, unchanged, already-linked)
    // invoice returns the identical link — persists only once.
    const linkRes2 = await request.post(`${API_URL}/api/invoices/${invoiceA.invoiceId}/payment-link`, {
      headers: tenantA.authHeaders,
    });
    expect(linkRes2.ok()).toBeTruthy();
    const link2 = (await linkRes2.json()) as { url: string };
    expect(link2.url).toBe(link1.url);

    const afterLink = await request.get(`${API_URL}/api/invoices/${invoiceA.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    const invoiceAfterLink = (await afterLink.json()) as {
      status: string;
      stripePaymentLinkUrl?: string;
      amountDueCents: number;
    };
    expect(invoiceAfterLink.status).toBe('open');
    expect(invoiceAfterLink.stripePaymentLinkUrl).toBe(link1.url);
    expect(invoiceAfterLink.amountDueCents).toBe(50_000);

    // ── T2 — tenant B's public page shows ONLY tenant B, never tenant A ─────
    await page.goto(`/pay/${invoiceB.viewToken}`);
    await expect(page.getByText('Bexar Plumbing 8.4', { exact: true })).toBeVisible();
    await expect(page.getByText('Acme HVAC 8.4', { exact: true })).toHaveCount(0);

    // ── Customer opens tenant A's public invoice page ───────────────────────
    // Reachability boundary, reported honestly rather than faked: the
    // embedded Stripe <PaymentElement> can only mount once
    // POST /api/public-payments/create-payment-intent returns a real
    // client_secret, and that route 503s with STRIPE_NOT_CONFIGURED whenever
    // deps.stripeConfig is null (packages/api/src/routes/public-payments.ts:107-116)
    // — true in this sandbox, which has no STRIPE_SECRET_KEY and no route to
    // Stripe's real API. Stubbing Stripe.js client-side (e2e/helpers/stripe-stub.ts)
    // does not change this: the gate is server-side, ahead of any client code.
    // So the actual "Pay" control this environment can show is the honest
    // "Online payment is temporarily unavailable" fallback
    // (data-testid="stripe-not-configured") — asserted below — not a faked
    // PaymentElement. This is the last reachable step for that half of the
    // story; settlement itself (below) does not depend on the Elements UI
    // ever having rendered, so it proceeds independently, exactly as the
    // story anticipates ("the hosted Stripe checkout cannot be hermetic").
    await page.goto(`/pay/${invoiceA.viewToken}`);
    await expect(page.getByText('Acme HVAC 8.4', { exact: true })).toBeVisible();
    await expect(page.getByText('$500.00').first()).toBeVisible();
    await expect(page.getByTestId('stripe-not-configured')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '8.4-invoice-before.png') });

    // ── The hosted Stripe checkout cannot be hermetic — settle the SAME way
    //    packages/api/test/integration/invoice-webhook-paid.test.ts does: a
    //    SIGNED checkout.session.completed webhook straight to the real API. ─
    const eventId = `evt_${randomUUID()}`;
    const webhookBody = JSON.stringify({
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenant_id: tenantA.tenantId, invoice_id: invoiceA.invoiceId },
          amount_total: invoiceA.totalCents,
          payment_status: 'paid',
          payment_intent: `pi_${eventId}`,
        },
      },
    });
    const webhookRes = await request.post(`${API_URL}/webhooks/stripe`, {
      headers: {
        'content-type': 'application/json',
        // Non-null: `canRun` (gated above via test.skip) requires this env
        // var to be set before this test body ever executes.
        'stripe-signature': stripeSignature(webhookBody, STRIPE_WEBHOOK_SECRET!),
      },
      data: webhookBody,
    });
    expect(webhookRes.ok(), `webhooks/stripe -> ${webhookRes.status()} ${await webhookRes.text()}`).toBeTruthy();
    expect(await webhookRes.json()).toEqual({ received: true });

    // The public page reflects settlement on reload — the durable proof,
    // not the client's own optimistic state.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /Payment received!/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('$500.00').first()).toBeVisible();
    await page.screenshot({ path: join(SCREENSHOT_DIR, '8.4-invoice-after-payment.png') });

    // ── Durable proof at the API / DB layer ──────────────────────────────────
    const paidInvoice = await request.get(`${API_URL}/api/invoices/${invoiceA.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    const paidBody = (await paidInvoice.json()) as {
      status: string;
      amountPaidCents: number;
      amountDueCents: number;
    };
    expect(paidBody.status).toBe('paid');
    expect(paidBody.amountPaidCents).toBe(50_000);
    expect(paidBody.amountDueCents).toBe(0);

    const paymentRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT amount_cents, status FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantA.tenantId, invoiceA.invoiceId],
    );
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0].amount_cents).toBe(50_000);

    const recordedAudit = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'invoice' AND entity_id = $2 AND event_type = 'payment.recorded'`,
      [tenantA.tenantId, invoiceA.invoiceId],
    );
    expect(recordedAudit).toHaveLength(1);

    const statusChangedAudit = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type, metadata FROM audit_events WHERE tenant_id = $1 AND entity_type = 'invoice' AND entity_id = $2 AND event_type = 'invoice.status_changed'`,
      [tenantA.tenantId, invoiceA.invoiceId],
    );
    expect(statusChangedAudit).toHaveLength(1);
    expect((statusChangedAudit[0].metadata as { newStatus?: string }).newStatus).toBe('paid');

    // A paid invoice is no longer payable — the mint guard refuses a new link.
    const linkAfterPaid = await request.post(`${API_URL}/api/invoices/${invoiceA.invoiceId}/payment-link`, {
      headers: tenantA.authHeaders,
    });
    expect(linkAfterPaid.status()).toBe(409);

    // ── Tenant B's invoice and link are completely untouched ────────────────
    const invoiceBAfter = await request.get(`${API_URL}/api/invoices/${invoiceB.invoiceId}`, {
      headers: tenantB.authHeaders,
    });
    const bBody = (await invoiceBAfter.json()) as { status: string; amountPaidCents: number };
    expect(bBody.status).toBe('open');
    expect(bBody.amountPaidCents).toBe(0);

    expect(pageErrors, 'no uncaught page errors during the pay-from-link journey').toEqual([]);
  });
});
