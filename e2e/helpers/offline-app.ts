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
// Pure data module (constants + latestReleaseId, no React/browser imports) —
// safe to import Node-side. Importing the real value keeps the walkthrough
// seed drift-proof: adding a release automatically updates the seed.
import { WHATS_NEW_SEEN_KEY, latestReleaseId } from '../../packages/web/src/components/walkthrough/whatsNew';

// WelcomeWalkthrough's dismissal key. Its source lives in a .tsx (React) so we
// mirror the stable v1 string here rather than importing that module Node-side.
// Source: packages/web/src/components/walkthrough/WelcomeWalkthrough.ts (WELCOME_SEEN_KEY).
const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';

/**
 * Seed localStorage so the first-run walkthroughs (WelcomeWalkthrough +
 * WhatsNewModal, both mounted in Shell) never open. On a fresh browser
 * context these modals overlay the app and intercept clicks — they'd break
 * every offline interaction spec, and they aren't what any offline spec is
 * testing. Runs before app scripts via addInitScript.
 */
async function suppressWalkthroughs(page: Page): Promise<void> {
  await page.addInitScript(
    ({ welcomeKey, whatsNewKey, whatsNewVal }) => {
      try {
        window.localStorage.setItem(welcomeKey, new Date(0).toISOString());
        if (whatsNewVal) window.localStorage.setItem(whatsNewKey, whatsNewVal);
      } catch {
        /* storage disabled — the modals will show; specs that click will surface it */
      }
    },
    {
      welcomeKey: WELCOME_SEEN_KEY,
      whatsNewKey: WHATS_NEW_SEEN_KEY,
      whatsNewVal: latestReleaseId(),
    },
  );
}

/**
 * True only for real API calls. A glob like `**\/api\/**` would also match
 * Vite's dev-server module URLs (/src/api/me.ts …) and intercept the app's
 * own source files — killing the boot before any fetch fires.
 */
export const isApiUrl = (url: URL) => url.pathname.startsWith('/api/');

/**
 * Timeout for the FIRST data-visible assertion after navigating to a route.
 * The Vite dev server compiles a route's chunk on first hit (JIT), and heavy
 * pages (jobs/estimates/invoices detail pull in large trees) can push that
 * cold compile past Playwright's default 5s `expect` timeout — intermittently,
 * right at the boundary. Product render itself is fast and deterministic once
 * compiled; this headroom only absorbs the one-time dev-server compile, so it
 * belongs on the first paint of each navigation, not on later interactions.
 */
export const DATA_TIMEOUT = 20_000;

/** Abort every request that leaves the app's own origin. See header (2). */
export async function blockExternalHosts(page: Page, baseURL: string): Promise<void> {
  const appOrigin = new URL(baseURL).origin;
  await page.route(
    (url) => url.origin !== appOrigin,
    (route) => route.abort(),
  );
}

/**
 * One intercepted API request, as recorded by a domain mock's tracker.
 * Mutation assertions read these (exact), GET entries exist only for
 * "the last list request carried filter X" checks — never count GETs
 * (StrictMode + pollers refire them).
 */
export interface ApiTrackerEntry {
  method: string;
  path: string;
  /** Parsed JSON body for mutations; query-string map for GETs. */
  body?: unknown;
  query?: Record<string, string>;
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
      await suppressWalkthroughs(page);
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
    // auto: the harness (Clerk stub + external abort + catch-all recorder +
    // baseline shell mocks + skip gate + pageerror audit) MUST run for every
    // offline spec, whether or not the test destructures `offlineApp`. A test
    // that only takes `{ page }` still needs the app to boot signed-in.
    { auto: true },
  ],
});

export { expect };
