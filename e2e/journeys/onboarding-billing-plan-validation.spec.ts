import { test, expect } from '@playwright/test';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { API_URL, bootstrapOwner } from '../fixtures/onboarding-hermetic-lane';

/**
 * 1.7 — "I want a 14-day trial with no card surprises, so I can try this
 * without commitment." Acceptance: a plan whose price fails live Stripe
 * validation is OMITTED from checkout, never shown at a wrong price.
 *
 * `integration/billing-trial.test.ts` + `integration/trial-provisioning-
 * first-value.test.ts` already prove this at real Postgres, but both
 * inject a MOCKED `fetchFn` (BillingService's own injectable dependency,
 * `packages/api/src/billing/subscription.ts` — `this.deps.fetchFn ?? fetch`)
 * to simulate Stripe's response — never the real `api.stripe.com`, and
 * never through a browser.
 *
 * This spec drives the REAL `/onboarding` billing step through the browser
 * against real Postgres, with NO plan price env vars configured — the
 * ACTUAL current production state of this deployment (no
 * STRIPE_BASIC_PRICE_ID / STRIPE_ENTERPRISE_PRICE_ID are set; see
 * docs/audit/blocked-on-josh.md's launch-flags notes). `resolvePlanPriceId`
 * fails closed for each plan BEFORE any Stripe call
 * (subscription.ts:59-70), `listPlans()` (subscription.ts:374+) then finds
 * zero valid plans and the route (`routes/onboarding.ts` `GET
 * /billing/plans`) 503s rather than ever rendering a broken/priceless plan
 * card — proving the "never shown at a wrong price" half of the acceptance
 * for real, through the real route, with the real (current) config.
 *
 * The OTHER half — a plan that IS configured but whose Stripe price fails
 * live validation (rather than being absent) — needs `validatePlanPrice`
 * (subscription.ts:293-345) to actually run, which requires a real Stripe
 * secret key and network egress this hermetic harness intentionally does
 * not exercise (same class of gap as the already-parked #1000/#1002
 * decision — a live third-party the hermetic suite cannot fake without
 * defeating the point of the proof). Pinned below with `test.fail()`
 * rather than faked with a mocked fetch.
 */

const REPORT_DIR = 'setup-8-1-r5';

test.describe('onboarding billing plan validation (1.7) — real Postgres, real /api/onboarding/billing/plans route', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !process.env.STRIPE_BASIC_PRICE_ID &&
    !process.env.STRIPE_ENTERPRISE_PRICE_ID;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres (E2E_USE_TEST_DB=true) with NO ' +
      'STRIPE_BASIC_PRICE_ID / STRIPE_ENTERPRISE_PRICE_ID set — this spec proves the fail-closed ' +
      'omission at the CURRENT (unconfigured) production state.',
  );

  test('with no plan prices configured, GET /api/onboarding/billing/plans fails closed (503, no plans array) and the real billing step never renders a broken/wrong-priced plan card', async ({
    page,
    baseURL,
  }) => {
    const owner = await bootstrapOwner(page, 'billingplans');

    // Direct route check — the structured proof.
    const plansRes = await page.request.get(`${API_URL}/api/onboarding/billing/plans`, {
      headers: owner.authHeaders,
    });
    expect(plansRes.status(), 'no validated plans -> fails closed, not an empty 200 array').toBe(503);
    const plansBody = (await plansRes.json()) as { error?: string };
    expect(plansBody.error).toBe('BILLING_PLANS_UNAVAILABLE');

    // Browser reachability — identity + pack via the real API (already
    // proven at the UI by 1.2's/1.3's own specs), phone clears on its own
    // via the signup dev-stub worker, landing the real wizard on the real
    // BillingStep.
    await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...owner.authHeaders },
      data: JSON.stringify({
        businessName: 'Billing Plans HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 15000,
        timezone: 'America/Chicago',
      }),
    });
    await page.request.post(`${API_URL}/api/onboarding/pack`, {
      headers: { 'content-type': 'application/json', ...owner.authHeaders },
      data: JSON.stringify({ packId: 'hvac' }),
    });

    await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
    await blockExternalHosts(page, baseURL!);
    await page.goto('/onboarding');

    // The onboarding status hook retries a transient first-load failure on
    // its own exponential backoff (useOnboardingStatus.ts), but under this
    // shared sandbox's variable system load a manual nudge is faster and
    // more reliable than waiting out the backoff window inside a single
    // long assertion — retried a few times rather than once (RED: a lone
    // click occasionally raced the SAME transient condition and lost).
    const loadError = page.getByRole('heading', { name: /couldn't load your setup/i });
    const tryAgainButton = page.getByRole('button', { name: /try again/i });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await loadError.isVisible({ timeout: 5_000 }).catch(() => false))) break;
      await tryAgainButton.click();
    }

    await expect(
      page.getByRole('heading', { name: /start your 14-day free trial/i }),
    ).toBeVisible({ timeout: 30_000 });
    // The fail-closed message, not a broken card with a missing/garbage price.
    await expect(page.getByText(/no billing plans are currently configured/i)).toBeVisible({
      timeout: 10_000,
    });
    // Never a rendered plan card (the radiogroup BillingStep renders one
    // radio button per validated plan, each showing its own price) — the
    // fail-closed error message replaces it entirely, it doesn't sit next
    // to a broken/priceless card. (A generic marketing bullet on this same
    // screen legitimately contains a dollar sign — "500 voice minutes
    // included; $0.30 each after" — so asserting "no $ anywhere" would be
    // a false positive; the radiogroup is the actual claim.)
    await expect(page.getByRole('radiogroup', { name: /choose a billing plan/i })).toHaveCount(0);
    await page.screenshot({
      path: `docs/audit/lane-reports/${REPORT_DIR}/1.7-billing-plans-omitted.png`,
      fullPage: true,
    });
  });

  test('PINNED GAP — a plan configured with a price that FAILS live Stripe validation (vs. simply unconfigured) is not exercised hermetically', async () => {
    test.fail(
      true,
      'validatePlanPrice (packages/api/src/billing/subscription.ts:293-345) performs a real ' +
        'fetch to https://api.stripe.com/v1/prices/... — exercising the "configured but invalid" ' +
        'branch (as opposed to resolvePlanPriceId\'s "unconfigured" early-throw, subscription.ts:59-70, ' +
        'already proven reachable above) requires a real Stripe secret key and live network egress to a ' +
        'third party, which this hermetic harness does not exercise. Same class of gap as the already-' +
        'parked #1000/#1002 decision (live Stripe/device dependencies the mock cannot script without a ' +
        'mocked fetchFn — which billing-trial.test.ts already does at the unit/integration layer; this ' +
        'lane does not re-count that as rung-5 real-surface proof).',
    );
    throw new Error(
      'Not attempted: requires a real Stripe secret key + live network egress to api.stripe.com — see reason above.',
    );
  });
});
