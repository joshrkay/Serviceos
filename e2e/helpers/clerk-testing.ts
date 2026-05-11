/**
 * Clerk testing-tokens helper for Playwright E2E tests.
 *
 * This wraps `@clerk/testing/playwright` (the official package) and exposes a
 * single `setupClerkTestingToken(page)` function for the journey specs. The
 * underlying mechanism is documented at:
 *   https://clerk.com/docs/testing/playwright
 *
 * How it works (short version):
 *   1. `globalSetup` (see e2e/global-setup.ts) calls `clerkSetup()`. That fetches
 *      a testing token from the Clerk Backend API using `CLERK_SECRET_KEY` and
 *      sets `CLERK_FAPI` + `CLERK_TESTING_TOKEN` in `process.env` for the run.
 *   2. Each test that drives Clerk UI calls `setupClerkTestingToken(page)`.
 *      That registers a route handler which appends the testing token to every
 *      Clerk Frontend API request so Clerk skips bot detection / CAPTCHA.
 *   3. The test can then submit signup / login forms normally and Clerk treats
 *      it as a trusted automated request.
 *
 * ─── Required environment variables ────────────────────────────────────────
 * These must be set in the SHELL that runs `playwright test` (and in CI):
 *
 *   E2E_CLERK_PUBLISHABLE_KEY   pk_test_... — same Clerk dev instance the web
 *                               app uses. Read by `clerkSetup()` (we also alias
 *                               it to CLERK_PUBLISHABLE_KEY for the SDK).
 *   E2E_CLERK_SECRET_KEY        sk_test_... — Clerk dev instance secret. Used
 *                               once at global-setup to mint the testing token.
 *                               Never sent to the browser.
 *
 * The same `pk_test_` value must also be exposed to the Vite dev server as
 * `VITE_CLERK_PUBLISHABLE_KEY` so the React app boots (main.tsx throws without
 * it). The CI workflow exports both names from the same secret.
 *
 * Dashboard prerequisite (one-time):
 *   Clerk dashboard → your dev instance → Configure → "Testing" → toggle
 *   "Testing mode" on. The dev instance keys are testing-token-capable by
 *   default once that flag is enabled.
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────
 *   import { setupClerkTestingToken, hasClerkTestingCreds } from '../helpers/clerk-testing';
 *
 *   test.skip(!hasClerkTestingCreds(), 'set E2E_CLERK_* env vars');
 *
 *   test('signup flow', async ({ page }) => {
 *     await setupClerkTestingToken(page);
 *     await page.goto('/signup');
 *     // ...drive the form normally...
 *   });
 *
 * For email-code or password sign-in flows from a known test user, prefer the
 * higher-level `clerk.signIn({ page, signInParams })` helper from
 * `@clerk/testing/playwright` directly — it calls `setupClerkTestingToken`
 * internally and then talks to Clerk via `window.Clerk`.
 */

import { setupClerkTestingToken as clerkSetupToken } from '@clerk/testing/playwright';
import type { Page } from '@playwright/test';

/**
 * Returns true iff both Clerk env vars required for the testing-token flow
 * are present. Used by specs to skip cleanly in environments where the test
 * Clerk instance has not been configured yet (e.g. fresh local clones, or PR
 * CI before the GH secrets land).
 */
export function hasClerkTestingCreds(): boolean {
  // CLERK_FAPI is set by globalSetup → clerkSetup() and proves both the
  // publishable key AND the secret key reached the Clerk Backend API.
  // We also accept the raw env vars so a developer can see a meaningful
  // skip reason without having to run globalSetup first.
  const hasPubKey = !!(
    process.env.E2E_CLERK_PUBLISHABLE_KEY ||
    process.env.CLERK_PUBLISHABLE_KEY ||
    process.env.VITE_CLERK_PUBLISHABLE_KEY
  );
  const hasSecret = !!(process.env.E2E_CLERK_SECRET_KEY || process.env.CLERK_SECRET_KEY);
  return hasPubKey && hasSecret;
}

/**
 * Registers the Clerk testing-token route handler on the page's context so
 * subsequent navigations to the app can complete Clerk flows without
 * triggering CAPTCHA / bot detection.
 *
 * MUST be called BEFORE `page.goto()` for the page under test, otherwise the
 * first Clerk FAPI request will fire before the route handler is registered.
 *
 * Safe to call multiple times per context — the underlying handler dedupes.
 */
export async function setupClerkTestingToken(page: Page): Promise<void> {
  if (!process.env.CLERK_FAPI) {
    throw new Error(
      'setupClerkTestingToken called but CLERK_FAPI is unset. ' +
        'This usually means globalSetup did not run, or the E2E_CLERK_* ' +
        'env vars are missing. See e2e/helpers/clerk-testing.ts.'
    );
  }
  await clerkSetupToken({ page });
}
