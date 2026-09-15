import { test, expect } from '@playwright/test';
import { setupClerkTestingToken, hasClerkTestingCreds } from '../helpers/clerk-testing';
import { submitClerkEmailForm, enterClerkTestCode } from '../helpers/clerk-email-form';

/**
 * Legacy real-Clerk signup smoke. Requires an explicitly selected deployed
 * test environment: Clerk cannot deliver its real webhook to a local CI API.
 * Full first-estimate and returning-login coverage lives in
 * e2e/release/onboarding.spec.ts and the manual Release verification workflow.
 */

test.describe('Real Clerk signup smoke', () => {
  test.skip(!process.env.E2E_BASE_URL, 'Real Clerk signup requires the deployed test environment webhook destination');
  // Skip cleanly when the Clerk testing-token env vars aren't configured (fresh
  // clones / PR CI before secrets land). The smoke tests still cover that the
  // page renders — this skip is *only* for the testing-token-driven flow.
  test.skip(
    !hasClerkTestingCreds(),
    'Clerk testing-token creds not set. See e2e/helpers/clerk-testing.ts ' +
      'and qa/reports/2026-05-11/clerk-testing-tokens-runbook.md.'
  );

  test('new user can sign up and the API recognizes their tenant', async ({ page }) => {
    // 1. Register the Clerk testing-token route handler BEFORE we navigate so
    //    the first Clerk Frontend API call carries the bot-bypass token.
    await setupClerkTestingToken(page);

    // 2. Land on signup page.
    await page.goto('/signup');
    await expect(page.getByText('Rivet', { exact: true })).toBeVisible();

    // 3. Fill the Clerk-hosted signup form with a Clerk *test* email address.
    //    Any email containing the `+clerk_test` subaddress is automatically
    //    treated as a test account by Clerk — verification codes default to
    //    `424242` and OTP delivery is skipped. See:
    //    https://clerk.com/docs/testing/test-emails-and-phones
    const testEmail = `e2e+clerk_test+${Date.now()}@serviceos-test.com`;

    // Clerk's hosted SignUp component renders its inputs inside the page;
    // selectors are stable on `name` / role.
    const emailInput = page.getByLabel(/email/i).first();
    await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
    await emailInput.fill(testEmail);

    const passwordInput = page.getByLabel(/password/i).first();
    await passwordInput.fill('E2ETestPassword!123');

    await submitClerkEmailForm(page);

    // 4. Clerk may prompt for an email verification code. With a `+clerk_test`
    //    address the code is always `424242`. The input may not appear if
    //    Clerk has disabled email verification for the dev instance.
    const codeInput = page.getByRole('textbox', { name: /code|verification/i }).first();
    const needsCode = await codeInput.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
    if (needsCode) await enterClerkTestCode(page);

    // 5. Expect the app to redirect to an authenticated landing route.
    //    The current router sends authed users to `/` or `/onboarding`.
    await expect(page).toHaveURL(/\/(onboarding|estimates|assistant|$)/, {
      timeout: 20_000,
    });

    // 6. Verify `/api/me` returns 200 with a real tenant id — proves the
    //    Clerk webhook fired and `bootstrapTenant` ran server-side.
    const token = await page.evaluate(async () => {
      const auth = (window as unknown as { Clerk?: { session?: { getToken(options: { template: string; skipCache: boolean }): Promise<string | null> } } }).Clerk;
      return auth?.session?.getToken({ template: 'serviceos', skipCache: true });
    });
    expect(token, 'authenticated Clerk session bearer token').toBeTruthy();
    const meRes = await page.request.get('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(meRes.status()).toBe(200);
    const me = (await meRes.json()) as { tenant_id?: string };
    expect(me.tenant_id).toBeTruthy();
  });

});
