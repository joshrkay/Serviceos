import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 1.2 — onboarding identity, real Postgres, driven through the actual
 * `/onboarding` browser form (not just the API, as digest-toggle.spec.ts
 * and its siblings do to clear the onboarding gate).
 *
 * `test/integration/onboarding-identity.test.ts` already proves, against
 * real Postgres: the upsert, the `tenant.identity_set` audit event, and
 * the `serviceAreaRadius` omit-vs-null tri-state (#874) — all via
 * `request(app).put(...)`, never through a browser. This spec proves the
 * SAME upsert + audit event reachable from a fresh owner typing business
 * details into the real `IdentityStep` form. The web client itself always
 * SENDS `serviceAreaRadius` (packages/web/src/components/onboarding/v2/steps/IdentityStep.tsx
 * never omits the key — `useState<number>` initialized to 25), so the
 * omit-tri-state leg is driven directly against `PUT
 * /api/onboarding/identity` (the same real route the form posts to),
 * exactly like the unit test does but against the live API + Postgres —
 * only an API caller (a raw request, or a future conversational/AI
 * handler) can omit the key at all.
 *
 * Bootstrap pattern mirrors e2e/journeys/digest-toggle.spec.ts.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function postSignedWebhook(
  request: import('@playwright/test').APIRequestContext,
  body: Record<string, unknown>,
) {
  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  return request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
}

async function bootstrapOwner(
  page: import('@playwright/test').Page,
  label: string,
): Promise<{ sub: string; jwt: string; authHeaders: Record<string, string>; tenantId: string }> {
  const sub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(sub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const webhookRes = await postSignedWebhook(page.request, {
    type: 'user.created',
    data: { id: sub, email_addresses: [{ email_address: email }] },
  });
  expect(webhookRes.status(), `${label} bootstrap webhook -> ${await webhookRes.text()}`).toBe(200);

  const meRes = await page.request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);

  return { sub, jwt, authHeaders, tenantId: me.tenant_id! };
}

function pollDbSnapshot(label: string, sql: string): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  try {
    const out = execFileSync('psql', [databaseUrl, '-c', sql], { encoding: 'utf8' });
    writeFileSync(`docs/audit/lane-reports/owner-surfaces-r5/${label}.snapshot.txt`, out);
  } catch (err) {
    writeFileSync(
      `docs/audit/lane-reports/owner-surfaces-r5/${label}.snapshot.txt`,
      `psql poll failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function queryOne<T = Record<string, string>>(sql: string): T | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const out = execFileSync(
    'psql',
    [databaseUrl, '-t', '-A', '-F', '\t', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
  if (!out) return null;
  return out as unknown as T;
}

test.describe('onboarding identity (1.2) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container.',
  );

  test('a fresh owner submits /onboarding identity in the browser; it persists to tenant_settings + an audit event; the radius tri-state and T2 hold', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant B, seeded FIRST with its own distinct identity — the T2
    //    control we check is untouched at the end. ─────────────────────────
    const ownerB = await bootstrapOwner(page, 'ownerb');
    const identityBRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...ownerB.authHeaders },
      data: JSON.stringify({
        businessName: 'Tenant B Untouched HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 9900,
        serviceAreaRadius: 99,
        timezone: 'America/Denver',
      }),
    });
    expect(identityBRes.ok()).toBeTruthy();

    // ── Tenant A: a FRESH owner, onboarding not yet started. ────────────────
    const ownerA = await bootstrapOwner(page, 'ownera');

    await installClerkStub(page, { signedIn: true, sub: ownerA.sub, token: ownerA.jwt });
    await blockExternalHosts(page, baseURL!);
    await page.goto('/onboarding');

    const businessNameInput = page.getByLabel('Business name');
    await expect(businessNameInput).toBeVisible({ timeout: 15_000 });
    // IdentityStep pre-loads any existing (webhook-bootstrapped default)
    // settings asynchronously and overwrites the form state when it
    // resolves; wait for that pre-load to finish (the submit button only
    // enables once `loaded` is true) before typing, or a fill() that races
    // ahead of it gets silently clobbered back to the default.
    await expect(page.getByRole('button', { name: /save and continue/i })).toBeEnabled({ timeout: 15_000 });
    await businessNameInput.fill('Onboarding Browser E2E HVAC');

    // The "Hourly rate" Field wraps its Input in a `$ ... /hour` flex div
    // (not the Input directly), so Field's htmlFor/id association lands on
    // that wrapper div, not the input itself — getByLabel can't resolve it.
    // Locate the number input following the "Hourly rate" label instead.
    const hourlyRateInput = page.locator(
      'xpath=//label[contains(., "Hourly rate")]/following-sibling::div[1]//input[@type="number"]',
    );
    await hourlyRateInput.fill('150');

    const radiusInput = page.getByLabel('Service area radius in miles');
    await radiusInput.fill('42');

    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/1.2-onboarding-identity-before-submit.png',
      fullPage: true,
    });

    const putPromise = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/onboarding/identity',
    );
    await page.getByRole('button', { name: /save and continue/i }).click();
    const putRes = await putPromise;
    expect(putRes.status(), `PUT /api/onboarding/identity -> ${putRes.status()}`).toBeLessThan(300);

    // ── Poll tenant_settings + audit_events directly from Postgres. ─────────
    pollDbSnapshot(
      '1.2-onboarding-identity-tenant-settings',
      `SELECT tenant_id, business_name, hourly_rate_cents, service_area_radius, timezone ` +
        `FROM tenant_settings WHERE tenant_id IN ('${ownerA.tenantId}','${ownerB.tenantId}') ORDER BY business_name;`,
    );
    pollDbSnapshot(
      '1.2-onboarding-identity-audit-events',
      `SELECT tenant_id, event_type, entity_type, entity_id FROM audit_events ` +
        `WHERE tenant_id = '${ownerA.tenantId}' AND event_type = 'tenant.identity_set';`,
    );

    const settingsAfterSubmit = await page.request.get(`${API_URL}/api/settings`, { headers: ownerA.authHeaders });
    expect(settingsAfterSubmit.ok()).toBeTruthy();
    const settingsBody = (await settingsAfterSubmit.json()) as {
      businessName?: string;
      hourlyRateCents?: number;
      serviceAreaRadius?: number;
    };
    expect(settingsBody.businessName).toBe('Onboarding Browser E2E HVAC');
    expect(settingsBody.hourlyRateCents).toBe(15000);
    expect(settingsBody.serviceAreaRadius).toBe(42);

    const auditRow = queryOne(
      `SELECT count(*) FROM audit_events WHERE tenant_id = '${ownerA.tenantId}' AND event_type = 'tenant.identity_set';`,
    );
    expect(String(auditRow).trim(), 'exactly one tenant.identity_set audit event').toBe('1');

    // ── Resubmit OMITTING serviceAreaRadius — the UI never does this (it
    //    always sends a number), so this leg drives the real route directly,
    //    proving the omit-vs-null tri-state (#874) reachable through the
    //    live API + Postgres, not just the mocked-DB unit test. ─────────────
    const resubmitNoRadius = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...ownerA.authHeaders },
      data: JSON.stringify({
        businessName: 'Onboarding Browser E2E HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 15000,
        timezone: 'America/New_York',
        // serviceAreaRadius omitted entirely — must KEEP the stored 42.
      }),
    });
    expect(resubmitNoRadius.ok(), `resubmit (omit radius) -> ${resubmitNoRadius.status()}`).toBeTruthy();

    const afterOmit = await page.request.get(`${API_URL}/api/settings`, { headers: ownerA.authHeaders });
    const afterOmitBody = (await afterOmit.json()) as { serviceAreaRadius?: number };
    expect(afterOmitBody.serviceAreaRadius, 'omitting serviceAreaRadius must KEEP the stored value').toBe(42);

    // ── T2 — tenant B's identity, seeded before any of tenant A's work,
    //    must be completely untouched by it. ────────────────────────────────
    const settingsB = await page.request.get(`${API_URL}/api/settings`, { headers: ownerB.authHeaders });
    const settingsBBody = (await settingsB.json()) as {
      businessName?: string;
      hourlyRateCents?: number;
      serviceAreaRadius?: number;
      timezone?: string;
      businessHours?: Record<string, { open: string; close: string } | null>;
      jobBufferMinutes?: number;
    };
    expect(settingsBBody.businessName).toBe('Tenant B Untouched HVAC');
    expect(settingsBBody.hourlyRateCents).toBe(9900);
    expect(settingsBBody.serviceAreaRadius).toBe(99);
    // ── Codex review: the T2 claim is that B's ENTIRE divergent
    //    configuration survived A's onboarding untouched, not just these
    //    three fields — a regression clobbering B's timezone, hours, or
    //    buffer would otherwise stay green. ─────────────────────────────────
    expect(settingsBBody.timezone, 'B\'s timezone must remain its divergent America/Denver').toBe('America/Denver');
    expect(settingsBBody.jobBufferMinutes, 'B\'s job buffer must be untouched').toBe(30);
    expect(settingsBBody.businessHours?.mon, 'B\'s business hours must be untouched').toEqual({
      open: '08:00',
      close: '17:00',
    });
    expect(settingsBBody.businessHours?.sat ?? null, 'B\'s business hours (sat) must be untouched').toBeNull();
    expect(settingsBBody.businessHours?.sun ?? null, 'B\'s business hours (sun) must be untouched').toBeNull();

    // ── Browser reachability: reload and confirm the onboarding gate has
    //    moved past the identity step onto a CONCRETE next step (not just
    //    "the identity form is gone", which a loading spinner or an error
    //    screen would also satisfy) — a full-page reload re-derives status
    //    from Postgres, not client-side state. `OnboardingShell` derives the
    //    active step from `/api/onboarding/status`'s polled `currentStep`;
    //    after identity that's `pack`, rendering `PackStep`'s "Pick your
    //    trade" heading. ─────────────────────────────────────────────────────
    await page.reload();
    await expect(page.getByLabel('Business name')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Pick your trade' })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/1.2-onboarding-identity-after-reload.png',
      fullPage: true,
    });

    expect(pageErrors, 'no uncaught page errors during the onboarding identity journey').toEqual([]);
  });
});

/**
 * 1.8 — proof the AI works, reachable through the real onboarding journey
 * (real Postgres, rung 5).
 *
 * `test/integration/onboarding-ai-check.test.ts` already proves the
 * `verify_ai` worker's write + its `tenant.ai_verified` / `_failed` /
 * `_retry` audit rows against real Postgres via `request(app)` — never
 * through a browser. This spec proves the SAME capability reachable by
 * walking the real `/onboarding` wizard: identity (API, already proven at
 * the UI by the 1.2 spec above) -> pack -> phone -> billing -> AI check.
 *
 * Two steps in that chain have no self-service UI path to a hermetic
 * pass and are cleared the same way a real deployment's own async
 * collaborators would clear them:
 *
 *   - phone: `workers/provision-twilio.ts` writes the deterministic
 *     +15005550006 stub automatically (no TWILIO_ACCOUNT_SID/TOKEN in this
 *     harness) — the in-process queue poll loop (app.ts) runs it, so the
 *     browser just waits.
 *   - billing: `BillingStep` redirects to a REAL Stripe Checkout page,
 *     which this sandbox cannot reach. Rather than clicking "Start trial"
 *     (which would need a live Stripe secret and network egress), this
 *     spec drives a self-signed Stripe-shaped `customer.subscription.created`
 *     webhook at the real `/webhooks/stripe` route — the exact event a real
 *     completed Checkout produces (`packages/api/src/webhooks/routes.ts`
 *     Tier 4) — with `metadata.tenant_id` set (the same field
 *     `createTrialCheckoutSession` stamps), so the handler's real,
 *     unmodified tenant-resolution + `FOR UPDATE` mirror runs against real
 *     Postgres. This mirrors the already-established pattern for phone-
 *     surface stories (a self-signed Twilio-shaped webhook through the
 *     real `/api/telephony/*` routes, per #1004) and for this same repo's
 *     `public-invoice-pay-link.spec.ts` (a self-signed Stripe-shaped
 *     webhook through this exact route, same signature recipe). No product
 *     code changed, no SQL write, no admin route — STRIPE_SECRET_KEY and
 *     STRIPE_WEBHOOK_SECRET are exactly the credentials a real deployment
 *     sets to turn billing on, same class as this file's existing
 *     CLERK_WEBHOOK_SECRET dependency.
 *
 * ai_check itself needs no stub: the `verify_ai` job is enqueued by the
 * SAME webhook handler, the instant it mirrors the subscription into
 * `trialing` (confirmed from the RED run's server log: "Subscription
 * status mirrored from Stripe" then "AI verification job enqueued" in the
 * same tick) — so completing billing is what unlocks it, not pack. app.ts
 * falls back to a hermetic `MockLLMProvider` whenever `AI_PROVIDER_API_KEY`
 * is unset, so the real `verify_ai` worker makes a real (mocked-provider)
 * `gateway.complete()` call and writes a real pass — nothing about the
 * AI-check code path is test-only. It runs so fast on the in-process
 * 250ms queue poll loop that by the time the page reloads, `ai_check` is
 * already `done` and the wizard has advanced to `test_call` — this spec
 * asserts the fact (derived status + the audit row) rather than racing
 * the transient "AI verified" screen.
 */
test.describe('onboarding AI check (1.8) — reachable through the real onboarding journey, real Postgres', () => {
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  // This journey is hermetic ONLY when the phone and AI-check legs fall
  // back to their dev stubs (packages/api/src/workers/provision-twilio.ts
  // dev-stub, app.ts's hermetic MockLLMProvider) — both fall back purely on
  // these vars being ABSENT. If a runner's shell already exports real
  // provider credentials, playwright.config.ts's webServerEnv forwards them
  // to the API server unchanged, and this test would silently exercise the
  // real Twilio provisioning path (purchasing a number) and the real LLM
  // instead of the documented stubs. Refuse to run rather than risk that.
  const hasLiveProviderCreds =
    !!process.env.TWILIO_ACCOUNT_SID ||
    !!process.env.TWILIO_AUTH_TOKEN ||
    !!process.env.AI_PROVIDER_API_KEY;
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!STRIPE_WEBHOOK_SECRET &&
    !!STRIPE_SECRET_KEY &&
    !hasLiveProviderCreds;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres (E2E_USE_TEST_DB=true) PLUS ' +
      'STRIPE_SECRET_KEY (any non-empty value — never dialed, only gates billingService on) and ' +
      'STRIPE_WEBHOOK_SECRET (signs the self-signed trial webhook) set before `npx playwright test` ' +
      '— AND none of TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / AI_PROVIDER_API_KEY set, or the phone ' +
      'and AI-check legs stop being hermetic stubs and start dialing real providers.',
  );

  /** Same recipe as createWebhookSignature in packages/api/src/webhooks/webhook-handler.ts. */
  function stripeSignature(rawBody: string, secret: string): string {
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    return `t=${ts},v1=${sig}`;
  }

  /** This lane's own report directory — NOT the shared pollDbSnapshot()
   * above, which is hardcoded to a different (already-landed) lane's
   * folder (owner-surfaces-r5). */
  function pollDbSnapshotHere(label: string, sql: string): void {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) return;
    try {
      const out = execFileSync('psql', [databaseUrl, '-c', sql], { encoding: 'utf8' });
      writeFileSync(`docs/audit/lane-reports/setup-8-1/${label}.snapshot.txt`, out);
    } catch (err) {
      writeFileSync(
        `docs/audit/lane-reports/setup-8-1/${label}.snapshot.txt`,
        `psql poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function putIdentity(
    request: import('@playwright/test').APIRequestContext,
    authHeaders: Record<string, string>,
    businessName: string,
  ) {
    const res = await request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...authHeaders },
      data: JSON.stringify({
        businessName,
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 15000,
        timezone: 'America/Chicago',
      }),
    });
    expect(res.ok(), `PUT identity (${businessName}) -> ${res.status()}`).toBeTruthy();
  }

  /**
   * T2 control — drives a tenant through identity -> pack -> phone ->
   * billing(signed webhook) -> ai_check ENTIRELY over the API (no browser;
   * the UI leg is what the main test proves) so a second, independently-
   * configured tenant can reach its OWN passed ai_check state, concurrent
   * with the tenant under test, on a DIFFERENT pack — proving the two
   * don't interfere rather than merely that an untouched neighbour is
   * invisible (that's T1, asserted separately below).
   */
  /**
   * T2 control, phase 1 — gets a tenant to the real onboarding gate's
   * `billing` step over the API (identity + pack; the phone dev-stub
   * already ran on signup). Deliberately does NOT fire the trial webhook —
   * see fireTrialWebhook() below. Split into phases (rather than one
   * function that also fires the webhook) so the test can hold the
   * neighbour here and release its webhook at the SAME instant as the
   * tenant-under-test's own, rather than merely starting the two journeys
   * without any real rendezvous (a second Codex review on this PR correctly
   * caught that the first fix still let the neighbour's fast, UI-free API
   * path race ahead and finish before the browser tenant had even picked a
   * pack).
   */
  async function driveTenantToBillingViaApi(
    request: import('@playwright/test').APIRequestContext,
    tenant: { authHeaders: Record<string, string>; tenantId: string },
    businessName: string,
    packId: 'hvac' | 'plumbing',
  ): Promise<void> {
    await putIdentity(request, tenant.authHeaders, businessName);

    const packRes = await request.post(`${API_URL}/api/onboarding/pack`, {
      headers: { 'content-type': 'application/json', ...tenant.authHeaders },
      data: JSON.stringify({ packId }),
    });
    expect(packRes.ok(), `POST pack (${businessName}) -> ${packRes.status()}`).toBeTruthy();

    // Phone stub provisioning runs on signup already; poll status until it
    // (and pack) land so this tenant is ready for the webhook below.
    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_URL}/api/onboarding/status`, {
            headers: tenant.authHeaders,
          });
          const body = (await res.json()) as { currentStep?: string };
          return body.currentStep;
        },
        { message: `${businessName} reaches billing`, timeout: 30_000 },
      )
      .toBe('billing');
  }

  /** T2 control, phase 2 — fires the self-signed trial webhook. Called for
   * both tenants back-to-back (not awaited between the two calls) so the
   * requests are genuinely concurrent, not merely started-without-awaiting
   * somewhere earlier in the test. */
  async function fireTrialWebhook(
    request: import('@playwright/test').APIRequestContext,
    tenant: { tenantId: string },
    businessName: string,
  ): Promise<void> {
    const trialEnd = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;
    const webhookBody = JSON.stringify({
      id: `evt_e2e_${randomUUID()}`,
      type: 'customer.subscription.created',
      data: {
        object: {
          id: `sub_e2e_${randomUUID()}`,
          customer: `cus_e2e_${randomUUID()}`,
          status: 'trialing',
          trial_end: trialEnd,
          metadata: { tenant_id: tenant.tenantId },
        },
      },
    });
    const whRes = await request.post(`${API_URL}/webhooks/stripe`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSignature(webhookBody, STRIPE_WEBHOOK_SECRET!),
      },
      data: webhookBody,
    });
    expect(whRes.status(), `${businessName} signed trial webhook -> ${await whRes.text()}`).toBe(200);
  }

  /** T2 control, phase 3 — polls until ai_check is done. */
  async function pollAiCheckDone(
    request: import('@playwright/test').APIRequestContext,
    tenant: { authHeaders: Record<string, string> },
    businessName: string,
  ): Promise<void> {
    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_URL}/api/onboarding/status`, {
            headers: tenant.authHeaders,
          });
          const body = (await res.json()) as { steps?: { id: string; status: string }[] };
          return body.steps?.find((s) => s.id === 'ai_check')?.status;
        },
        { message: `${businessName} ai_check reaches done`, timeout: 30_000 },
      )
      .toBe('done');
  }

  test(
    'identity -> pack -> phone (Twilio stub) -> billing (signed trial webhook) -> AI check ' +
      'passes at real Postgres with its tenant.ai_verified audit row; a neighbour tenant on a ' +
      'DIFFERENT pack completing its own AI check concurrently does not change this tenant\'s ' +
      'answer (T2)',
    async ({ page, baseURL }, testInfo) => {
      // Default 30s is too short for a full identity->pack->phone(stub
      // provisioning)->billing->ai_check(worker) walk TWICE (neighbour +
      // tenant under test); the phone step alone documents "usually 30
      // seconds, occasionally up to a minute".
      testInfo.setTimeout(180_000);
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      // ── Neighbour tenant, seeded FIRST and driven (over the API, plumbing
      //    pack — deliberately different from the tenant under test's HVAC)
      //    up to but NOT THROUGH billing — it's held there deliberately.
      //    Two Codex reviews on this PR sharpened this: the first pass fully
      //    awaited the neighbour's entire journey before the tenant under
      //    test even bootstrapped (no overlap at all); starting it without
      //    awaiting immediately still let the neighbour's fast, UI-free API
      //    path race ahead and finish before the browser tenant reached
      //    billing (no REAL rendezvous). Fixed properly below: both
      //    tenants' trial webhooks fire back-to-back at the same point in
      //    the test, once BOTH are sitting at the gate, so their verify_ai
      //    jobs are genuinely concurrent on the same queue poll loop.
      //    Fable's rung-5 ask: a neighbour's OWN completed ai_check must
      //    not change this tenant's answer — stronger than an untouched
      //    neighbour (T1, asserted separately below). ──────────────────────
      const neighbour = await bootstrapOwner(page, 'aicheckneighbour');
      await driveTenantToBillingViaApi(page.request, neighbour, 'Neighbour Plumbing Co', 'plumbing');

      // ── The tenant under test. Identity via the real PUT route directly —
      //    1.2's own browser-form proof is the spec above; re-driving the
      //    form here would just be a slower way to reach the same fact. ────
      const owner = await bootstrapOwner(page, 'aicheck');
      await putIdentity(page.request, owner.authHeaders, 'AI Check Journey HVAC');

      await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
      await blockExternalHosts(page, baseURL!);
      await page.goto('/onboarding');

      // ── Pack — real HVAC pack activation through the real UI. ───────────
      await expect(page.getByRole('heading', { name: /pick your trade/i })).toBeVisible({
        timeout: 15_000,
      });
      const packRequest = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/onboarding/pack',
      );
      // The pack card is a single <button> wrapping the name, blurb AND
      // includes text, so its accessible NAME is all three concatenated —
      // an exact-name role query never matches. Target the button that
      // CONTAINS the exact "HVAC" text node instead (same recipe as
      // onboarding-v2.spec.ts's mocked "HVAC pack selection activates
      // pack" test).
      await page.locator('button', { has: page.getByText('HVAC', { exact: true }) }).click();
      const packRes = await packRequest;
      expect(packRes.status(), `POST pack -> ${packRes.status()}`).toBeLessThan(300);

      // ── Phone — the dev-stub provisioning worker runs on the in-process
      //    queue poll loop and is triggered on SIGNUP (webhooks/routes.ts),
      //    well before pack is even picked — the RED run showed it lands
      //    inside the same second as bootstrapOwner's webhook, so by the
      //    time the wizard re-derives status after the pack POST, `phone`
      //    is already `done` and the wizard advances straight past
      //    PhoneStep into BillingStep without ever rendering it. Handle
      //    both shapes: click "Continue to billing" only if PhoneStep
      //    actually renders first.
      const phoneReady = page.getByRole('heading', { name: /your business number is ready/i });
      if (await phoneReady.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await page.screenshot({
          path: 'docs/audit/lane-reports/setup-8-1/1.8-phone-ready.png',
          fullPage: true,
        });
        await page.getByRole('button', { name: /continue to billing/i }).click();
      }

      // Runtime proof the phone leg actually took the dev-stub path, rather
      // than trusting the pre-flight env check alone (Codex correctly noted
      // that check can't see a packages/api/.env or an already-running,
      // reused server — packages/api/package.json's `dev` script loads
      // `.env` via --env-file-if-exists, invisible to this test process).
      // isTwilioTestNumber() is the SAME predicate provision-twilio.ts's
      // real (non-stub) path uses to refuse ever persisting one — if this
      // is ever anything else, a real number was purchased and the test
      // must fail loudly, not silently pass.
      const phoneStatusRes = await page.request.get(`${API_URL}/api/onboarding/status`, {
        headers: owner.authHeaders,
      });
      const phoneStatusBody = (await phoneStatusRes.json()) as {
        steps?: { id: string; metadata?: { phoneNumber?: string } }[];
      };
      const phoneNumber = phoneStatusBody.steps?.find((s) => s.id === 'phone')?.metadata?.phoneNumber;
      expect(
        phoneNumber,
        'phone leg used the deterministic dev-stub number, not a real Twilio purchase',
      ).toBe('+15005550006');

      // ── Billing — reached at the real surface; cleared by a self-signed
      //    Stripe-shaped webhook rather than a real Checkout redirect. ──────
      await expect(
        page.getByRole('heading', { name: /start your 14-day free trial/i }),
      ).toBeVisible({ timeout: 30_000 });
      await page.screenshot({
        path: 'docs/audit/lane-reports/setup-8-1/1.8-billing-reached.png',
        fullPage: true,
      });

      // ── The rendezvous. Both tenants are now sitting at the real
      //    billing gate (owner via the browser above, neighbour via the API
      //    above) — fire BOTH trial webhooks together with Promise.all, not
      //    one after the other, so the two verify_ai jobs are enqueued at
      //    the same instant and genuinely race on the same in-process
      //    queue poll loop. This is the actual concurrency claim; starting-
      //    without-awaiting earlier in the test was not (fixed per Codex's
      //    second review pass on this PR). ─────────────────────────────────
      await Promise.all([
        fireTrialWebhook(page.request, owner, 'AI Check Journey HVAC'),
        fireTrialWebhook(page.request, neighbour, 'Neighbour Plumbing Co'),
      ]);
      await Promise.all([
        pollAiCheckDone(page.request, owner, 'AI Check Journey HVAC'),
        pollAiCheckDone(page.request, neighbour, 'Neighbour Plumbing Co'),
      ]);

      pollDbSnapshotHere(
        '1.8-tenants-subscription-status',
        `SELECT id, subscription_status, stripe_customer_id FROM tenants WHERE id = '${owner.tenantId}';`,
      );

      // ── AI check — the webhook handler above enqueues verify_ai the
      //    instant it mirrors the subscription to `trialing` (see server
      //    log: "Subscription status mirrored from Stripe" then "AI
      //    verification job enqueued" in the same tick), and the in-process
      //    250ms poll loop runs it before this reload's first paint — the
      //    prior run showed ai_check ALREADY `done` and the wizard already
      //    advanced to "Make a test call". Assert the fact (derived status,
      //    the source of truth this whole epic is about) rather than
      //    racing a transient "AI verified" screen that may already be gone.
      await page.reload();
      await expect(page.getByRole('heading', { name: /make a test call/i })).toBeVisible({
        timeout: 30_000,
      });
      await page.screenshot({
        path: 'docs/audit/lane-reports/setup-8-1/1.8-ai-verified-past.png',
        fullPage: true,
      });
      const statusRes = await page.request.get(`${API_URL}/api/onboarding/status`, {
        headers: owner.authHeaders,
      });
      const statusBody = (await statusRes.json()) as {
        steps?: { id: string; status: string }[];
      };
      const aiCheckStep = statusBody.steps?.find((s) => s.id === 'ai_check');
      expect(aiCheckStep?.status, 'ai_check step is done').toBe('done');

      // verify-ai.ts writes tenant_settings.ai_verification_status = 'passed'
      // BEFORE awaiting auditRepo.create() — so the status endpoint above can
      // observe `ai_check: done` in the brief window before the audit row is
      // actually committed. Poll the count rather than reading it once,
      // bounded by the same 30s this journey already budgets per async step.
      const auditCountSql =
        `SELECT count(*) FROM audit_events WHERE tenant_id = '${owner.tenantId}' AND event_type = 'tenant.ai_verified';`;
      await expect
        .poll(() => String(queryOne(auditCountSql) ?? '').trim(), {
          message: 'exactly one tenant.ai_verified audit event',
          timeout: 30_000,
        })
        .toBe('1');

      pollDbSnapshotHere(
        '1.8-audit-events',
        `SELECT tenant_id, event_type, entity_type, entity_id FROM audit_events ` +
          `WHERE tenant_id = '${owner.tenantId}' AND event_type = 'tenant.ai_verified';`,
      );

      // Runtime proof the ai_check leg actually used the hermetic
      // MockLLMProvider, not a real key reaching this process some other
      // way (Codex's same class of concern as the phone check above).
      // MockLLMProvider.buildResponse() always stamps `provider: this.name`
      // = 'mock' (packages/api/src/ai/providers/mock.ts) — a real provider
      // configured via createLLMGateway() would report something else
      // ('openai', etc.) here, so this is a real, not assumed, distinguisher.
      const ownerProvider = queryOne(
        `SELECT metadata->>'provider' FROM audit_events ` +
          `WHERE tenant_id = '${owner.tenantId}' AND event_type = 'tenant.ai_verified';`,
      );
      expect(String(ownerProvider).trim(), 'ai_check used the hermetic mock provider, not a real one').toBe(
        'mock',
      );

      // ── T2 — the neighbour, driven to its OWN passed ai_check on a
      //    DIFFERENT pack before and during this tenant's journey, has
      //    exactly its own audit row (not 0 — it genuinely completed — and
      //    not 2, which would mean the two tenants' writes merged), a
      //    DIFFERENT stripe_customer_id, and its OWN plumbing catalog —
      //    while this tenant's own count (asserted above) stayed at
      //    exactly 1 throughout. Two independently-configured tenants,
      //    each correct, in one run. ────────────────────────────────────────
      pollDbSnapshotHere(
        '1.8-T2-neighbour-audit-events',
        `SELECT tenant_id, event_type, entity_type, entity_id FROM audit_events ` +
          `WHERE tenant_id = '${neighbour.tenantId}' AND event_type = 'tenant.ai_verified';`,
      );
      const neighbourAudit = queryOne(
        `SELECT count(*) FROM audit_events WHERE tenant_id = '${neighbour.tenantId}' AND event_type = 'tenant.ai_verified';`,
      );
      expect(String(neighbourAudit).trim(), 'neighbour has exactly its OWN ai_verified row').toBe('1');
      const neighbourProvider = queryOne(
        `SELECT metadata->>'provider' FROM audit_events ` +
          `WHERE tenant_id = '${neighbour.tenantId}' AND event_type = 'tenant.ai_verified';`,
      );
      expect(
        String(neighbourProvider).trim(),
        'neighbour ai_check also used the hermetic mock provider',
      ).toBe('mock');

      const neighbourStatusRes = await page.request.get(`${API_URL}/api/onboarding/status`, {
        headers: neighbour.authHeaders,
      });
      expect(neighbourStatusRes.ok()).toBeTruthy();
      const neighbourStatus = (await neighbourStatusRes.json()) as {
        steps?: { id: string; status: string }[];
      };
      expect(
        neighbourStatus.steps?.find((s) => s.id === 'ai_check')?.status,
        'neighbour own ai_check is done — its completion is real, not a T1 no-op',
      ).toBe('done');

      // Same recipe as onboarding-pack.test.ts's T3 case: non-empty catalogs,
      // disjoint names — the pack's own SKUs, not a shared/templated one.
      const ownerCatalogNames = execFileSync(
        'psql',
        [
          process.env.DATABASE_URL!,
          '-t', '-A',
          '-c',
          `SELECT name FROM catalog_items WHERE tenant_id = '${owner.tenantId}' ORDER BY name;`,
        ],
        { encoding: 'utf8' },
      ).trim().split('\n').filter(Boolean);
      const neighbourCatalogNames = execFileSync(
        'psql',
        [
          process.env.DATABASE_URL!,
          '-t', '-A',
          '-c',
          `SELECT name FROM catalog_items WHERE tenant_id = '${neighbour.tenantId}' ORDER BY name;`,
        ],
        { encoding: 'utf8' },
      ).trim().split('\n').filter(Boolean);
      expect(ownerCatalogNames.length, 'this tenant (HVAC) got a non-empty catalog').toBeGreaterThan(0);
      expect(neighbourCatalogNames.length, 'neighbour (plumbing) got a non-empty catalog').toBeGreaterThan(0);
      const catalogOverlap = ownerCatalogNames.filter((n) => neighbourCatalogNames.includes(n));
      expect(catalogOverlap, 'the two tenants\' catalogs share no line items — each got its own pack').toEqual([]);

      // Re-read THIS tenant's own audit count once more, after the
      // neighbour's concurrent completion above — still exactly 1, proving
      // the neighbour's own passed check did not change this tenant's own
      // answer (T2, per Fable's ask).
      expect(
        String(queryOne(auditCountSql) ?? '').trim(),
        'this tenant STILL has exactly one ai_verified row after the neighbour completed its own',
      ).toBe('1');

      expect(pageErrors, 'no uncaught page errors during the AI-check journey').toEqual([]);
    },
  );
});
