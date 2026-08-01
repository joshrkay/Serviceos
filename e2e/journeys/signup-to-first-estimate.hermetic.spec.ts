import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * Journey 1 — HERMETIC: signup → tenant bootstrap → authed app → first estimate.
 *
 * The sibling `signup-to-first-estimate.spec.ts` is the SECRET-GATED, real-Clerk
 * fidelity path (it drives Clerk's HOSTED signup UI via testing tokens and stays
 * `test.skip` until `E2E_CLERK_*` secrets land). THIS spec proves the SAME
 * journey with ZERO Clerk secrets so it gates every PR — it runs in the
 * always-on chromium project (no `hasClerkTestingCreds` guard).
 *
 * The signup half cannot drive Clerk's hosted UI (a remote service). Its
 * hermetic equivalent, mirroring the API-layer TEST-04 critical-path
 * (packages/api/test/integration/signup-to-paid-critical-path.test.ts):
 *
 *   1. POST a SIGNED `user.created` svix webhook to the REAL running API's
 *      `/webhooks/clerk` route → the REAL `bootstrapTenant()` creates the
 *      tenant + seeds settings server-side. The webhook secret is env-
 *      controlled (playwright.config.ts sets it on the API webServer).
 *   2. GET `/api/me` for that sub returns the REAL bootstrapped `tenant_id`
 *      (the exact server-side effect the skipped spec's `/api/me` check makes).
 *   3. Install the offline Clerk stub with the SAME sub + an UNSIGNED JWT so
 *      the BROWSER session is that real tenant's owner. The API runs in
 *      `DEV_AUTH_BYPASS` mode (packages/api/src/auth/dev-auth-bypass.ts), which
 *      decodes the unsigned sub and resolves the SAME shared in-memory
 *      tenantRepo the webhook wrote to (app.ts BUG-2 single-instance wiring).
 *   4. Create the first estimate's customer→location→job→estimate graph
 *      through the REAL API as that owner (the payloads verify-seed.mjs and the
 *      qa-matrix estimates spec use), then confirm the estimate RENDERS in the
 *      real authed SPA — the money-loop spec's `goto('/estimates')` + assert
 *      pattern (e2e/money-loop/estimate-approve-execute.spec.ts).
 *
 * No Clerk cloud, no Postgres, no secrets — the API boots in-memory.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

// Must match the CLERK_WEBHOOK_SECRET the API webServer boots with in
// playwright.config.ts. Hermetic constant (a base64 `whsec_` test value — NOT
// a real Clerk secret), so the signed webhook verifies on every PR runner.
const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** base64url a JSON object (Node Buffer — spec runs in the test process). */
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * Unsigned `header.payload.sig` JWT carrying `sub` — exactly what the API's
 * DEV_AUTH_BYPASS middleware decodes (it never verifies the signature).
 */
function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    sub,
    sid: 'dev-session',
    role: 'owner',
  })}.x`;
}

/** svix `v1,<base64 HMAC>` over `${id}.${ts}.${body}` (mirrors TEST-04). */
function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${sig}`;
}

// Suppress the welcome / what's-new walkthroughs so the first paint isn't
// blocked (mirrors e2e/helpers/offline-app.ts's suppressWalkthroughs).
const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

test.describe('Journey 1 (hermetic) — signup webhook → tenant → first estimate', () => {
  // This journey needs the LOCAL API webServer booted in DEV_AUTH_BYPASS mode
  // (playwright.config.ts's apiWebServerEnv). When E2E_BASE_URL points at a
  // deployed environment the local webServer is skipped and that API is NOT in
  // bypass mode — so the hermetic journey only runs against the local stack.
  // A (placeholder-ok) Vite Clerk key is still required for the SPA to boot.
  const hermeticLocal = !process.env.E2E_BASE_URL && hasViteClerkKey();
  test.skip(
    !hermeticLocal,
    'Hermetic Journey-1 runs against the local DEV_AUTH_BYPASS API webServer: ' +
      'leave E2E_BASE_URL unset and set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok).',
  );

  test('signed webhook bootstraps the tenant; stub session owns it; first estimate is created + visible', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const clerkUserId = `user_e2e_${randomUUID().replace(/-/g, '')}`;
    const ownerEmail = `owner-${Date.now()}@serviceos-hermetic.test`;
    const jwt = unsignedJwt(clerkUserId);
    const authHeaders = { Authorization: `Bearer ${jwt}` };

    // ── 1. SIGNUP (hermetic): signed user.created webhook → REAL bootstrapTenant ──
    // page.request is a standalone APIRequestContext — it is NOT subject to
    // page.route, so it reaches the real API directly (webhooks aren't proxied
    // by Vite). /webhooks/clerk is mounted express.raw(), so we send the EXACT
    // serialized bytes we signed.
    const svixId = `evt_signup_${randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      type: 'user.created',
      data: {
        id: clerkUserId,
        email_addresses: [{ email_address: ownerEmail }],
      },
    });
    const webhookRes = await page.request.post(`${API_URL}/webhooks/clerk`, {
      headers: {
        'content-type': 'application/json',
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
      },
      data: rawBody,
    });
    expect(
      webhookRes.status(),
      `webhook rejected: ${await webhookRes.text()}`,
    ).toBe(200);

    // ── 2. /api/me returns the REAL bootstrapped tenant for that sub ────────────
    // (The exact assertion the skipped real-Clerk spec makes — adapted to carry
    // the Bearer explicitly, since the browser stub has no ambient session that
    // an APIRequestContext would inherit.)
    const meRes = await page.request.get(`${API_URL}/api/me`, {
      headers: authHeaders,
    });
    expect(meRes.status(), `/api/me failed: ${await meRes.text()}`).toBe(200);
    const me = (await meRes.json()) as { tenant_id?: string };
    expect(me.tenant_id, '/api/me must report the bootstrapped tenant').toBeTruthy();
    expect(me.tenant_id).toMatch(UUID_RE);
    const tenantId = me.tenant_id!;

    // ── 3. Bind the BROWSER session to that same real tenant owner ─────────────
    await installClerkStub(page, { signedIn: true, sub: clerkUserId, token: jwt });
    await page.addInitScript(
      ({ welcomeKey, whatsNewKey }) => {
        try {
          localStorage.setItem(welcomeKey, '1');
          localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
        } catch {
          /* private mode — ignore */
        }
      },
      { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
    );
    await blockExternalHosts(page, baseURL!);

    // Prove the stub session (its unsigned JWT) is recognized by the REAL API as
    // the webhook-created tenant: capture the app's own boot-time GET /api/me.
    // Match the exact API pathname — `includes('/api/me')` also catches
    // Vite-served source modules whose path happens to contain that substring.
    const appMePromise = page.waitForResponse(
      (r) => {
        if (r.request().method() !== 'GET') return false;
        try {
          return new URL(r.url()).pathname === '/api/me';
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );
    await page.goto('/');
    const appMeRes = await appMePromise;
    expect(appMeRes.status(), 'app boot GET /api/me must be 200').toBe(200);
    const appMe = (await appMeRes.json()) as { tenant_id?: string };
    expect(
      appMe.tenant_id,
      'the browser session must resolve to the SAME real tenant the webhook bootstrapped',
    ).toBe(tenantId);

    // ── 4. FIRST ESTIMATE — create the graph through the REAL API as the owner ──
    // Payloads mirror packages/api/scripts/verify-seed.mjs (integer cents).
    const stamp = Date.now();
    const customer = await postJson(page, `${API_URL}/api/customers`, authHeaders, {
      firstName: 'Journey',
      lastName: `Owner ${stamp}`,
      primaryPhone: '555-0142',
      email: `journey.owner+${stamp}@example.com`,
      preferredChannel: 'sms',
      smsConsent: true,
      source: 'referral',
    });

    const location = await postJson(page, `${API_URL}/api/locations`, authHeaders, {
      customerId: customer.id,
      label: 'Home',
      street1: '482 Maple Avenue',
      city: 'Brooklyn',
      state: 'NY',
      postalCode: '11215',
      isPrimary: true,
    });

    const job = await postJson(page, `${API_URL}/api/jobs`, authHeaders, {
      customerId: customer.id,
      locationId: location.id,
      summary: 'AC not cooling — diagnostic + repair',
      problemDescription: 'Upstairs unit blows warm air; suspect low refrigerant.',
      priority: 'high',
    });

    const estimate = await postJson(page, `${API_URL}/api/estimates`, authHeaders, {
      jobId: job.id,
      lineItems: [
        {
          id: 'li-0',
          description: 'Diagnostic + system inspection',
          category: 'labor',
          quantity: 1,
          unitPriceCents: 12900,
          totalCents: 12900,
          sortOrder: 0,
          taxable: true,
        },
      ],
      discountCents: 0,
      taxRateBps: 800,
    });
    expect(estimate.id, 'estimate create must return an id').toBeTruthy();
    expect(estimate.status).toBe('draft');
    expect(estimate.estimateNumber).toBeTruthy();

    // ── 5. Confirm the first estimate RENDERS in the real authed SPA ────────────
    await page.goto('/estimates');
    await expect(page).toHaveURL(/\/estimates/);
    await expect(
      page.getByText(estimate.estimateNumber as string).first(),
    ).toBeVisible({ timeout: 15_000 });

    expect(pageErrors, 'no uncaught page errors during the hermetic journey').toEqual([]);
  });
});

interface CreatedEntity {
  id: string;
  status?: string;
  estimateNumber?: string;
  [k: string]: unknown;
}

/** POST JSON to the real API as the authed owner; assert 2xx and return body. */
async function postJson(
  page: import('@playwright/test').Page,
  url: string,
  authHeaders: Record<string, string>,
  body: unknown,
): Promise<CreatedEntity> {
  const res = await page.request.post(url, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.ok(), `POST ${url} -> ${res.status()}: ${text}`).toBeTruthy();
  return (text ? JSON.parse(text) : {}) as CreatedEntity;
}
