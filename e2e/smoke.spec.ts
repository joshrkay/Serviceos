import { test, expect } from '@playwright/test';

/**
 * Smoke tests — prove the Playwright harness itself is working.
 *
 * Split into two tiers:
 *   - API smoke: always runs. No external deps beyond the dev server.
 *   - UI smoke: requires VITE_CLERK_PUBLISHABLE_KEY. Skipped otherwise.
 *     (main.tsx throws at module-load when the key is missing, which is
 *     the intentional P0-026 startup guard — see packages/web/src/main.tsx.)
 *
 * If these fail, every other E2E test will also fail — fix these first.
 */

test.describe('smoke — api', () => {
  test('health endpoint responds 200', async ({ request }) => {
    const apiURL = process.env.E2E_API_URL ?? 'http://localhost:3000';
    const res = await request.get(`${apiURL}/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
  });
});

test.describe('smoke — ui', () => {
  // When E2E_BASE_URL is set (pointing at deployed env), Clerk is configured
  // there so we always run. Locally we run only if a Clerk pk is exported
  // into the dev server's environment.
  const hasClerk =
    !!process.env.E2E_BASE_URL ||
    !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

  test.skip(
    !hasClerk,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI smoke tests'
  );

  test('login page renders', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/login');

    // App-owned chrome (LoginPage.tsx) is the rebrand signal we control —
    // unlike Clerk's widget title, which is set in the Clerk dashboard.
    await expect(page.getByText('Rivet').first()).toBeVisible();
    await expect(page.getByText(/© 2026 Rivet/)).toBeVisible();
    // Prove the Clerk widget actually mounted via its email field — a form
    // control is more stable than the dashboard-configurable heading copy.
    // 15s mirrors the journey spec (signup-to-first-estimate.spec.ts): Clerk
    // mounts its widget async and Playwright's default 5s was already found
    // insufficient there.
    await expect(page.getByLabel(/email/i).first()).toBeVisible({ timeout: 15_000 });
    expect(consoleErrors).toEqual([]);
  });

  test('signup page renders', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.getByText('Rivet').first()).toBeVisible();
    // 15s: Clerk's <SignUp> mounts async — see the login test's note.
    await expect(page.getByLabel(/email/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('signed-out root shows the public landing page', async ({ page }) => {
    // ProtectedRoute renders the marketing LandingPage at "/" for signed-out
    // visitors — it no longer bounces to /login (see ProtectedRoute.tsx).
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole('heading', { name: /your ai dispatcher/i }),
    ).toBeVisible();
  });

  test('signed-out app route redirects to login', async ({ page }) => {
    await page.goto('/jobs');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
