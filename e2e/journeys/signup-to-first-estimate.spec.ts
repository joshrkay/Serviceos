import { test, expect } from '@playwright/test';

/**
 * Journey 1 — New user signs up and drafts their first estimate.
 *
 * Why this matters:
 *   This is the single path that has to work on day 1. Every piece below
 *   touches a real integration: Clerk signup + webhook, PG tenant bootstrap,
 *   Clerk session token, authenticated API calls, estimate repo write.
 *   If this journey works end-to-end, ~60% of the product works end-to-end.
 *
 * Current status: SKIPPED.
 *
 * To enable this test we need:
 *   1. Clerk testing-tokens setup (see https://clerk.com/docs/testing/playwright)
 *      - Enable testing mode on the Clerk dashboard for the dev instance
 *      - Set E2E_CLERK_PUBLISHABLE_KEY + E2E_CLERK_SECRET_KEY in CI secrets
 *   2. A real DATABASE_URL pointing at an ephemeral test PG (or PG branch)
 *   3. Migration runner executed against that DB before the test starts
 *   4. Teardown that drops the test tenant after the run
 *
 * Until 1-4 are in place, this spec documents the intended shape of the test
 * so the reviewer can see what coverage we're committing to.
 */

test.describe('Journey 1 — signup to first estimate', () => {
  test.skip('new user can sign up, get a tenant, and draft an estimate', async ({ page }) => {
    // 1. Land on signup page from the marketing site / direct link
    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: /sign up|create account/i })).toBeVisible();

    // 2. Fill Clerk signup form with a unique email
    const testEmail = `e2e-${Date.now()}@serviceos-test.com`;
    await page.getByLabel(/email/i).fill(testEmail);
    await page.getByLabel(/password/i).fill('E2ETestPassword!123');
    await page.getByRole('button', { name: /continue|sign up/i }).click();

    // 3. Handle Clerk's email verification step via testing tokens
    //    Testing tokens bypass the real OTP. Requires Clerk testing mode.
    // TODO: inject testing token here

    // 4. Expect redirect to /onboarding (or /) after Clerk session is live
    await expect(page).toHaveURL(/\/(onboarding|$)/, { timeout: 15_000 });

    // 5. Verify the Clerk webhook fired and a tenant was bootstrapped.
    //    Hit the API as the new user and expect 200 (not 403 = missing tenant).
    const meRes = await page.request.get('/api/me');
    expect(meRes.status()).toBe(200);
    const me = await meRes.json();
    expect(me.tenantId).toBeTruthy();

    // 6. Navigate to Estimates
    await page.goto('/estimates');
    await expect(page.getByRole('heading', { name: /estimates/i })).toBeVisible();

    // 7. Click "New estimate" and fill the minimum required fields
    await page.getByRole('button', { name: /new estimate/i }).click();
    await page.getByLabel(/customer/i).fill('E2E Test Customer');
    await page.getByLabel(/description|summary/i).fill('E2E test work');

    // 8. Save the draft. Expect it to show in the estimates list.
    await page.getByRole('button', { name: /save|create draft/i }).click();
    await expect(page.getByText('E2E Test Customer')).toBeVisible({ timeout: 10_000 });
  });
});
