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

    await expect(page.getByText('Fieldly').first()).toBeVisible();
    await expect(page.getByText(/© 2026 Fieldly/)).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test('signup page renders', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.getByText('Fieldly').first()).toBeVisible();
  });

  test('protected route redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
