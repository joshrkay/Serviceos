import { test, expect } from '@playwright/test';
import { setupClerkTestingToken, hasClerkTestingCreds } from '../helpers/clerk-testing';
import {
  createOnboardingMockState,
  installOnboardingV2ApiMocks,
  signUpAndReachOnboarding,
  type OnboardingMockTrackers,
} from '../helpers/onboarding-v2-mock';

/**
 * Journey — §10 onboarding v2 (self-serve setup).
 *
 * What this verifies:
 *   - Signing up via the real Clerk dev instance bootstraps a tenant
 *     (Clerk user.created webhook) and lands the user on /onboarding
 *     when VITE_ONBOARDING_V2_ENABLED=true.
 *   - The new sidebar shell renders with step 2 (Business identity)
 *     as the current step.
 *   - The identity form renders all required fields and accepts input.
 *   - Resumability: reloading mid-flow returns to the current step
 *     (because state is derived from real entities, no separate
 *     onboarding_progress table to get stale).
 *
 * Identity submit + HVAC pack selection use route mocks when the
 * journey DB cannot persist tenant_settings (see onboarding-v2-mock.ts).
 *
 * What's deliberately NOT covered here (deferred to follow-up):
 *   - Twilio readiness UI (depends on the worker actually purchasing
 *     a number; covered by the integration test suite).
 *   - Stripe Checkout (would hit live Stripe sandbox; covered by the
 *     billing-trial integration test with a mocked fetchFn).
 *   - Test-call detection (would require placing a real call;
 *     covered by the unit tests on derive-status).
 *
 * To run locally:
 *   export E2E_CLERK_PUBLISHABLE_KEY=pk_test_...
 *   export E2E_CLERK_SECRET_KEY=sk_test_...
 *   export VITE_CLERK_PUBLISHABLE_KEY="$E2E_CLERK_PUBLISHABLE_KEY"
 *   export VITE_ONBOARDING_V2_ENABLED=true
 *   npx playwright test e2e/journeys/onboarding-v2.spec.ts
 *
 * See qa/reports/2026-05-11/clerk-testing-tokens-runbook.md for the full setup.
 */

test.describe('Journey — §10 onboarding v2', () => {
  // Skip cleanly when Clerk testing creds aren't set OR when the v2 flag is
  // off (the legacy /onboarding renders OnboardingPage which has different
  // selectors — those are covered by the existing 9-step wizard tests).
  const v2Enabled = process.env.VITE_ONBOARDING_V2_ENABLED === 'true';

  test.skip(
    !hasClerkTestingCreds(),
    'Clerk testing-token creds not set. See e2e/helpers/clerk-testing.ts.',
  );
  test.skip(
    !v2Enabled,
    'VITE_ONBOARDING_V2_ENABLED=true required. The legacy wizard has its own coverage.',
  );

  test('fresh signup lands on /onboarding with sidebar shell', async ({ page }) => {
    await setupClerkTestingToken(page);

    // 1. Sign up via Clerk testing-token route.
    await page.goto('/signup');
    const testEmail = `e2e+clerk_test+v2+${Date.now()}@serviceos-test.com`;
    const emailInput = page.getByLabel(/email/i).first();
    await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
    await emailInput.fill(testEmail);

    const passwordInput = page.getByLabel(/password/i).first();
    await passwordInput.fill('Test1234!Test1234!');
    await page.getByRole('button', { name: /(continue|sign up)/i }).first().click();

    // 2. Clerk redirects to /onboarding after a successful signup +
    //    session-active. Wait for the URL to settle so the OnboardingGuard
    //    in ProtectedRoute has had a chance to evaluate isComplete.
    await page.waitForURL(/\/onboarding/, { timeout: 30_000 });

    // 3. The sidebar shell renders. Step 2 (Business identity) is the
    //    current step for a freshly-bootstrapped tenant.
    await expect(page.getByText('Setup', { exact: true })).toBeVisible();
    await expect(page.getByText('Business identity')).toBeVisible();
    await expect(page.getByText('Pick your trade')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Tell us about your business/i })).toBeVisible();

    // 4. The "Optional polish" footer is rendered but disabled until
    //    all 6 mandatory steps complete.
    await expect(page.getByText('Optional polish')).toBeVisible();
  });

  test('identity form fields render and accept input', async ({ page }) => {
    await setupClerkTestingToken(page);

    await page.goto('/signup');
    const testEmail = `e2e+clerk_test+v2form+${Date.now()}@serviceos-test.com`;
    const emailInput = page.getByLabel(/email/i).first();
    await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
    await emailInput.fill(testEmail);
    await page.getByLabel(/password/i).first().fill('Test1234!Test1234!');
    await page.getByRole('button', { name: /(continue|sign up)/i }).first().click();

    await page.waitForURL(/\/onboarding/, { timeout: 30_000 });

    // Required fields render.
    await expect(page.getByLabel(/Business name/i)).toBeVisible();
    await expect(page.getByLabel(/Hourly rate/i)).toBeVisible();
    await expect(page.getByLabel(/Job buffer/i)).toBeVisible();

    // Fields accept input.
    await page.getByLabel(/Business name/i).fill('E2E Acme HVAC');
    await page.getByLabel(/Hourly rate/i).fill('150');
    await expect(page.getByLabel(/Business name/i)).toHaveValue('E2E Acme HVAC');

    // Submit button is present and labeled correctly.
    await expect(page.getByRole('button', { name: /Save and continue/i })).toBeVisible();
  });

  test('identity form submit advances to pack step', async ({ page }) => {
    await setupClerkTestingToken(page);
    const state = createOnboardingMockState();
    const trackers: OnboardingMockTrackers = { identityPut: false, packPost: null };
    await installOnboardingV2ApiMocks(page, state, trackers);

    await signUpAndReachOnboarding(page, 'v2identity-submit');

    await expect(page.getByRole('heading', { name: /Tell us about your business/i })).toBeVisible();
    await page.getByLabel(/Business name/i).fill('E2E Acme HVAC');
    // Mon–Fri hours are on by default; satisfies "at least one business hours day".
    await page.getByRole('button', { name: /Save and continue/i }).click();

    await expect.poll(() => trackers.identityPut).toBe(true);
    await expect(page.getByRole('heading', { name: /Pick your trade/i })).toBeVisible({
      timeout: 15_000,
    });
    const packSidebar = page.getByRole('button', { name: /Pick your trade/i });
    await expect(packSidebar).toBeVisible();
    await expect(packSidebar).toContainText('→');
  });

  test('HVAC pack selection activates pack', async ({ page }) => {
    await setupClerkTestingToken(page);
    const state = createOnboardingMockState();
    state.identityDone = true;
    const trackers: OnboardingMockTrackers = { identityPut: false, packPost: null };
    await installOnboardingV2ApiMocks(page, state, trackers);

    await signUpAndReachOnboarding(page, 'v2pack-hvac');

    await expect(page.getByRole('heading', { name: /Pick your trade/i })).toBeVisible({
      timeout: 15_000,
    });

    const packRequest = page.waitForRequest(
      (req) =>
        req.method() === 'POST' &&
        req.url().includes('/api/onboarding/pack') &&
        req.postDataJSON()?.packId === 'hvac',
    );
    await page.locator('button', { has: page.getByText('HVAC', { exact: true }) }).click();
    await packRequest;

    expect(trackers.packPost).toEqual({ packId: 'hvac' });
    await expect(page.getByRole('button', { name: /Pick your trade/i })).toContainText('✓', {
      timeout: 15_000,
    });
  });

  test('resumability: reload mid-flow stays on /onboarding', async ({ page }) => {
    await setupClerkTestingToken(page);

    await page.goto('/signup');
    const testEmail = `e2e+clerk_test+v2resume+${Date.now()}@serviceos-test.com`;
    const emailInput = page.getByLabel(/email/i).first();
    await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
    await emailInput.fill(testEmail);
    await page.getByLabel(/password/i).first().fill('Test1234!Test1234!');
    await page.getByRole('button', { name: /(continue|sign up)/i }).first().click();

    await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
    await expect(page.getByText('Business identity')).toBeVisible();

    // Reload mid-flow. The OnboardingGuard re-evaluates against the
    // derived status; since identity isn't filled in, it stays on
    // /onboarding with step 2 still current.
    await page.reload();
    await page.waitForURL(/\/onboarding/);
    await expect(page.getByRole('heading', { name: /Tell us about your business/i })).toBeVisible();
  });

  test('app-shell guard: incomplete tenant trying to reach / redirects to /onboarding', async ({ page }) => {
    await setupClerkTestingToken(page);

    await page.goto('/signup');
    const testEmail = `e2e+clerk_test+v2guard+${Date.now()}@serviceos-test.com`;
    const emailInput = page.getByLabel(/email/i).first();
    await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
    await emailInput.fill(testEmail);
    await page.getByLabel(/password/i).first().fill('Test1234!Test1234!');
    await page.getByRole('button', { name: /(continue|sign up)/i }).first().click();

    await page.waitForURL(/\/onboarding/, { timeout: 30_000 });

    // Attempt to navigate directly to the home dashboard while
    // onboarding is incomplete. The OnboardingGuard should redirect
    // back to /onboarding.
    await page.goto('/');
    await page.waitForURL(/\/onboarding/, { timeout: 10_000 });
    await expect(page.getByText('Business identity')).toBeVisible();
  });
});
