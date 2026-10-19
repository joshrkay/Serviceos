import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * S5a-2 (U8) — "Collect on the spot" reaches the customer's screens, on the
 * REAL stack (e2e/onboarding-v3.config.ts: the API on a real Postgres, the SPA
 * in dev auth mode). Nothing is mocked: the owner writes the choice through
 * PUT /api/settings, creates, issues and sends an invoice and mints a portal
 * link through the real routes, and the customer opens the public invoice page
 * and the portal at 320 x 568.
 *
 * Proven at 320px: no horizontal overflow, the call link is a >=44px target,
 * the page never asks for a card payment (no request to
 * /api/public-payments/create-payment-intent), and the portal row says
 * "Pay in person" with no Pay now link. A neighbour tenant that never answered
 * the card (pay link, the default) is the control in the same run: its page
 * DOES ask for a card payment, so the absence above is the choice's doing.
 *
 * The "could not read the choice" leg needs a database fault, so it is proven
 * by InvoicePaymentPage.collectOnSite.test.tsx (web) and
 * packages/api/test/integration/payment-collection-mode.test.ts (API).
 *
 * Run: QA_CHROMIUM_PATH=... npx playwright test -c e2e/onboarding-v3.config.ts
 */
test.skip(
  process.env.E2E_ONBOARDING_V3_STACK !== '1',
  'Needs the real-stack config: npx playwright test -c e2e/onboarding-v3.config.ts',
);

const apiUrl = process.env.E2E_V3_API_URL ?? 'http://127.0.0.1:3011';
const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** The unsigned token the API's dev auth bypass decodes; each new `sub` is its own tenant. */
function devOwnerToken(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub, sid: `session-${sub}`, role: 'owner' })}.x`;
}

interface Seeded {
  viewToken: string;
  portalToken: string;
}

async function call<T>(
  request: APIRequestContext,
  auth: string,
  method: 'POST' | 'PUT' | 'GET',
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await request.fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
    ...(data === undefined ? {} : { data: JSON.stringify(data) }),
  });
  expect(res.ok(), `${method} ${path} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** A business with one sent, unpaid $125.00 invoice and a portal link for its customer. */
async function seedBusiness(
  request: APIRequestContext,
  label: string,
  businessName: string,
  mode: 'collect_on_site' | null,
): Promise<Seeded> {
  const auth = devOwnerToken(`e2e_s5a2_${label}_${randomUUID().replace(/-/g, '')}`);
  await call(request, auth, 'PUT', '/api/onboarding/identity', {
    businessName,
    businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
    jobBufferMinutes: 30,
    hourlyRateCents: 12500,
    timezone: 'America/New_York',
  });
  // The card's write, through the real generic settings route. The control
  // tenant writes only its phone, so its choice stays unset (= pay link).
  await call(request, auth, 'PUT', '/api/settings', {
    businessPhone: '+12165550100',
    ...(mode ? { paymentCollectionMode: mode } : {}),
  });

  const customer = await call<{ id: string }>(request, auth, 'POST', '/api/customers', {
    firstName: 'Jordan',
    lastName: 'Customer',
    email: `jordan-${randomUUID().slice(0, 8)}@example.test`,
    preferredChannel: 'email',
  });
  const location = await call<{ id: string }>(request, auth, 'POST', '/api/locations', {
    customerId: customer.id,
    street1: '1 Driveway Lane',
    city: 'Cleveland',
    state: 'OH',
    postalCode: '44101',
    isPrimary: true,
  });
  const job = await call<{ id: string }>(request, auth, 'POST', '/api/jobs', {
    customerId: customer.id,
    locationId: location.id,
    summary: 'Water heater repair',
  });
  const invoice = await call<{ id: string }>(request, auth, 'POST', '/api/invoices', {
    jobId: job.id,
    lineItems: [
      {
        id: randomUUID(),
        description: 'Water heater repair',
        quantity: 1,
        unitPriceCents: 12_500,
        totalCents: 12_500,
        sortOrder: 0,
        taxable: false,
      },
    ],
  });
  await call(request, auth, 'POST', `/api/invoices/${invoice.id}/issue`, {});
  const sent = await call<{ viewToken: string; paymentCollectionMode?: string }>(
    request,
    auth,
    'POST',
    `/api/invoices/${invoice.id}/send`,
    { channel: 'email' },
  );
  expect(sent.viewToken).toBeTruthy();
  // The send itself recorded the choice it applied (S5a-1).
  expect(sent.paymentCollectionMode).toBe(mode ?? 'pay_link');

  const portal = await call<{ token: string }>(request, auth, 'POST', '/api/portal-sessions', {
    customerId: customer.id,
  });
  return { viewToken: sent.viewToken, portalToken: portal.token };
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * Gives the page a (synthetic) publishable key through the runtime config hook
 * public/env.js preserves, so the card form is configured on BOTH tenants'
 * pages: without it the page skips the payment request for every tenant and
 * the absence below would prove nothing. Stripe's own hosts are refused, so
 * nothing leaves the box.
 */
async function configureCardForm(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __APP_CONFIG__?: Record<string, string> };
    w.__APP_CONFIG__ = { ...(w.__APP_CONFIG__ ?? {}), VITE_STRIPE_PUBLISHABLE_KEY: 'pk_test_hermetic_s5a2' };
  });
  await page.route(/https:\/\/([a-z0-9-]+\.)*stripe\.(com|network)\//, (route) => route.abort());
}

/** Records every card-payment request the page makes. */
function watchPaymentRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/public-payments/create-payment-intent')) seen.push(req.url());
  });
  return seen;
}

test.use({ viewport: { width: 320, height: 568 } });

test('collect on the spot: the invoice page and portal offer no online payment, at 320px', async ({ page, request }) => {
  test.setTimeout(120_000);
  const seeded = await seedBusiness(request, 'cos', 'Acme HVAC', 'collect_on_site');
  await configureCardForm(page);
  const paymentRequests = watchPaymentRequests(page);

  // ── The public invoice page ────────────────────────────────────────────
  const viewResponse = page.waitForResponse(
    (r) => r.url().includes(`/public/invoices/${seeded.viewToken}`) && r.request().method() === 'GET',
  );
  await page.goto(`/pay/${seeded.viewToken}`);
  const view = (await (await viewResponse).json()) as { paymentCollectionMode?: string; stripePaymentLinkUrl?: string };
  expect(view.paymentCollectionMode).toBe('collect_on_site');
  expect(view.stripePaymentLinkUrl).toBeUndefined();

  const note = page.getByTestId('pay-in-person');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Acme HVAC collects payment in person. Settle up when the work is done.');
  await expect(page.getByText('$125.00').first()).toBeVisible();

  const callLink = page.getByTestId('pay-in-person-call');
  await expect(callLink).toHaveAttribute('href', 'tel:+12165550100');
  const box = await callLink.boundingBox();
  expect(box, 'call link has a box').not.toBeNull();
  expect(box!.height, 'call link is under 44px tall').toBeGreaterThanOrEqual(44);
  expect(box!.x + box!.width, 'call link runs past the viewport').toBeLessThanOrEqual(320);

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await page.waitForLoadState('networkidle');
  expect(paymentRequests, 'the page asked for a card payment').toHaveLength(0);
  await expect(page.getByRole('button', { name: /Pay \$/ })).toHaveCount(0);
  await expect(page.getByText(/Powered by Stripe/)).toHaveCount(0);

  // ── The portal's invoice list ──────────────────────────────────────────
  await page.goto(`/portal/${seeded.portalToken}`);
  await page.getByRole('button', { name: 'Invoices', exact: true }).click();
  const label = page.getByTestId('portal-invoice-pay-in-person');
  await expect(label).toHaveText('Pay in person');
  await expect(page.getByRole('link', { name: 'Pay now' })).toHaveCount(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(paymentRequests).toHaveLength(0);
});

test('control: a business that never answered the card still gets the card form request', async ({ page, request }) => {
  test.setTimeout(120_000);
  const seeded = await seedBusiness(request, 'paylink', 'Bexar Plumbing', null);
  await configureCardForm(page);
  const paymentRequests = watchPaymentRequests(page);

  const firstPaymentRequest = page.waitForRequest((r) => r.url().includes('/api/public-payments/create-payment-intent'));
  await page.goto(`/pay/${seeded.viewToken}`);
  await expect(page.getByText('Bexar Plumbing', { exact: true })).toBeVisible();
  await firstPaymentRequest;
  expect(paymentRequests.length).toBeGreaterThan(0);
  await expect(page.getByTestId('pay-in-person')).toHaveCount(0);
  await expect(page.getByTestId('pay-unavailable')).toHaveCount(0);

  await page.goto(`/portal/${seeded.portalToken}`);
  await page.getByRole('button', { name: 'Invoices', exact: true }).click();
  await expect(page.getByText('$125.00 due')).toBeVisible();
  await expect(page.getByTestId('portal-invoice-pay-in-person')).toHaveCount(0);
});
