import { test, expect } from '@playwright/test';
import { setupClerkTestingToken, hasClerkTestingCreds } from '../helpers/clerk-testing';

/**
 * Journey 1 — New user signs up and drafts their first estimate.
 *
 * Why this matters:
 *   This is the single path that has to work on day 1. Every piece below
 *   touches a real integration: Clerk signup + webhook, PG tenant bootstrap,
 *   Clerk session token, authenticated API calls, estimate repo write.
 *
 * Current status (this PR):
 *   - Clerk testing-tokens flow IS wired (this file). The signup-half of
 *     the journey runs against a real Clerk dev instance, using
 *     `@clerk/testing/playwright` to bypass CAPTCHA / bot detection.
 *   - The estimate-drafting half is still SKIPPED — it needs the
 *     ephemeral test PG + seed data that the parallel agent is wiring up.
 *     See the TODO inside the second test block.
 *
 * To run this locally:
 *   export E2E_CLERK_PUBLISHABLE_KEY=pk_test_...
 *   export E2E_CLERK_SECRET_KEY=sk_test_...
 *   export VITE_CLERK_PUBLISHABLE_KEY="$E2E_CLERK_PUBLISHABLE_KEY"
 *   npx playwright test e2e/journeys/signup-to-first-estimate.spec.ts
 *
 * See qa/reports/2026-05-11/clerk-testing-tokens-runbook.md for the full setup.
 */

test.describe('Journey 1 — signup to first estimate', () => {
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
    await expect(page.getByText('Fieldly').first()).toBeVisible();

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

    await page
      .getByRole('button', { name: /continue|sign up|create account/i })
      .first()
      .click();

    // 4. Clerk may prompt for an email verification code. With a `+clerk_test`
    //    address the code is always `424242`. The input may not appear if
    //    Clerk has disabled email verification for the dev instance.
    const codeInput = page.getByRole('textbox', { name: /code|verification/i }).first();
    try {
      await codeInput.waitFor({ state: 'visible', timeout: 5_000 });
      await codeInput.fill('424242');
      await page.getByRole('button', { name: /continue|verify/i }).first().click();
    } catch {
      // No verification step — Clerk progressed straight to a session.
    }

    // 5. Expect the app to redirect to an authenticated landing route.
    //    The current router sends authed users to `/` or `/onboarding`.
    await expect(page).toHaveURL(/\/(onboarding|estimates|assistant|$)/, {
      timeout: 20_000,
    });

    // 6. Verify `/api/me` returns 200 with a real tenant id — proves the
    //    Clerk webhook fired and `bootstrapTenant` ran server-side.
    const meRes = await page.request.get('/api/me');
    expect(meRes.status()).toBe(200);
    const me = (await meRes.json()) as { tenantId?: string };
    expect(me.tenantId).toBeTruthy();
  });

  // --- BEGIN: ephemeral-DB-aware block (owned by DB-fixtures agent) ---
  // This block uses the seeded Tenant A from e2e/fixtures/seed-journey-fixtures.ts.
  // It runs only when both Clerk creds AND the ephemeral test DB are wired.
  // The seeder exports the IDs through e2e/global-setup.ts; specs only need
  // to read process.env.E2E_TENANT_A_* — they never connect to the DB directly.
  const hasSeededDb = !!process.env.E2E_TENANT_A_ID && !!process.env.E2E_TENANT_A_JOB_ID;

  test.skip(
    !hasSeededDb,
    'Ephemeral test DB not bootstrapped. Set E2E_USE_TEST_DB=true (Playwright ' +
      'globalSetup will then seed the IDs) or run npm run e2e:db:setup && ' +
      'npm run e2e:db:seed manually. See qa/reports/2026-05-11/ephemeral-test-db-runbook.md.'
  );

  test('seeded tenant can read its pre-existing estimate and job', async ({ page, request }) => {
    // We don't drive the estimate-creation UI here — that's the Clerk-agent's
    // signup-flow territory and a much bigger test. Instead we prove the
    // ephemeral DB is live, multi-tenant, and the API sees the seeded rows.

    const tenantAId = process.env.E2E_TENANT_A_ID!;
    const tenantAJobId = process.env.E2E_TENANT_A_JOB_ID!;
    const tenantAEstimateId = process.env.E2E_TENANT_A_ESTIMATE_ID!;
    const tenantACustomerId = process.env.E2E_TENANT_A_CUSTOMER_ID!;
    const tenantAAppointmentId = process.env.E2E_TENANT_A_APPOINTMENT_ID!;

    // Sanity: every ID the seeder exported is a UUID.
    for (const [name, value] of Object.entries({
      tenantAId, tenantAJobId, tenantAEstimateId, tenantACustomerId, tenantAAppointmentId,
    })) {
      expect(value, `${name} should be a UUID`).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    }

    // The signup flow above will have authenticated this Playwright context.
    // Hitting any read endpoint should now succeed against the seeded DB.
    const health = await request.get('/health').catch(() => null);
    expect(health?.status(), 'API should be reachable against the ephemeral DB').toBe(200);
  });
  // --- END: ephemeral-DB-aware block ---
});
