import { test, expect } from '@playwright/test';
import { setupClerkTestingToken, hasClerkTestingCreds } from '../helpers/clerk-testing';

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
 * What's deliberately NOT covered here (deferred to follow-up):
 *   - Submitting the identity form end-to-end (requires PG seed of
 *     the new tenant_settings columns or a real backend that has
 *     migration 098 applied — the journey infra seeds a different
 *     fixture set).
 *   - Picking a pack and asserting the sidebar advances.
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
