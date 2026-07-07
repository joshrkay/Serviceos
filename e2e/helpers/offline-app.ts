/**
 * Offline authed-app fixture — boots the REAL web bundle signed-in in a real
 * browser with ZERO network egress and ZERO backend, then audits errors.
 *
 * One import gives a spec:
 *
 *   import { offlineTest as test, expect } from '../helpers/offline-app';
 *
 * What the fixture installs, in registration order (Playwright route
 * matching is last-registered-wins, so later layers override earlier ones):
 *
 *   1. window.Clerk stub (helpers/clerk-stub.ts) — the app boots signed-in;
 *      clerk-react's loader adopts the pre-existing global and never
 *      downloads clerk-js, so any syntactically valid pk works.
 *   2. External-host abort — every request leaving the app's own origin is
 *      aborted (third-party analytics, fonts). Keeps the `load` event
 *      deterministic on egress-blocked runners and doubles as a standing
 *      check that blocked third parties never white-screen the app.
 *   3. Catch-all /api/* recorder — unmatched API calls are fulfilled with
 *      `200 {}` (so unrelated widgets don't paint error states) and their
 *      `METHOD /path` is pushed to `unmockedApiCalls`, keeping missing
 *      mocks loud instead of silent.
 *   4. Baseline shell mocks (api-mocks/shell.ts) — /api/me (persona without
 *      `ai:run`, which keeps the /api/ws WebSocket and voice pollers off),
 *      onboarding status (complete), proposals (empty), settings,
 *      escalations SSE.
 *   5. Spec-installed domain mocks and per-test overrides — registered in
 *      the test body, so they win over everything above.
 *
 * Teardown asserts zero uncaught page errors by default. Opt out per
 * describe/test with `test.use({ expectCleanPageErrors: false })` when a
 * scenario intentionally provokes them.
 *
 * StrictMode note: the dev server double-invokes mount effects and three
 * shell pollers refire GETs (30s/30s/30s) — GET handlers must stay
 * idempotent and specs must never assert on GET counts. Assert on mutation
 * trackers (user-action-triggered) instead.
 */

import { test as base, expect, Page, Route } from '@playwright/test';
import { installClerkStub, readClerkStubCounters, ClerkStubCounters } from './clerk-stub';
import { installShellMocks } from './api-mocks/shell';

/**
 * True only for real API calls. A glob like `**\/api\/**` would also match
 * Vite's dev-server module URLs (/src/api/me.ts …) and intercept the app's
 * own source files — killing the boot before any fetch fires.
 */
export const isApiUrl = (url: URL) => url.pathname.startsWith('/api/');

/** Abort every request that leaves the app's own origin. See header (2). */
export async function blockExternalHosts(page: Page, baseURL: string): Promise<void> {
  const appOrigin = new URL(baseURL).origin;
  await page.route(
    (url) => url.origin !== appOrigin,
    (route) => route.abort(),
  );
}

export interface OfflineApp {
  /** `METHOD /path` of every /api call no mock claimed (catch-all hits). */
  unmockedApiCalls: string[];
  /** Uncaught page errors collected for the test's lifetime. */
  pageErrors: string[];
  /** Clerk stub call counters (signOutCalls, getTokenCalls). */
  clerkCounters: () => Promise<ClerkStubCounters>;
}

interface OfflineFixtures {
  offlineApp: OfflineApp;
  expectCleanPageErrors: boolean;
}

const hasWebApp = !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

export const offlineTest = base.extend<OfflineFixtures>({
  expectCleanPageErrors: [true, { option: true }],

  offlineApp: [
    async ({ page, baseURL, expectCleanPageErrors }, use, testInfo) => {
      testInfo.skip(
        !hasWebApp,
        'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI E2E tests',
      );

      const unmockedApiCalls: string[] = [];
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      await installClerkStub(page, { signedIn: true });
      await blockExternalHosts(page, baseURL!);

      // Catch-all /api recorder — layer 3 (see header).
      await page.route(isApiUrl, async (route: Route) => {
        const req = route.request();
        unmockedApiCalls.push(`${req.method()} ${new URL(req.url()).pathname}`);
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });

      // Baseline shell mocks — layer 4; registered after the catch-all so
      // they win for their paths.
      await installShellMocks(page);

      await use({
        unmockedApiCalls,
        pageErrors,
        clerkCounters: () => readClerkStubCounters(page),
      });

      if (expectCleanPageErrors) {
        expect(pageErrors, 'no uncaught page errors during the test').toEqual([]);
      }
    },
    { auto: false },
  ],
});

export { expect };
