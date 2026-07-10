/**
 * Shared Playwright fixture: boots the real SPA signed-in with zero network
 * egress (Clerk stub + external abort + baseline shell mocks).
 *
 * Usage:
 *   import { test, expect } from '../helpers/offline-app';
 *   test('…', async ({ page, apiTracker, pageErrors }) => { … });
 *
 * Specs that need domain data register their mocks in the test body AFTER
 * the fixture has set up the baseline (last-registered-wins).
 */

import { test as base, expect, type Page } from '@playwright/test';
import { installClerkStub, readClerkStubCounters, type ClerkStubCounters } from './clerk-stub';
import {
  blockExternalHosts,
  installApiCatchAll,
  installShellMocks,
  type UnmockedApiCall,
} from './api-mocks/shell';
import { hasViteClerkKey } from './clerk-key';

export { expect };

// Mirrored from packages/web walkthrough modules — keep as literals so the
// e2e harness does not import the web app graph.
const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

export interface ApiMutation {
  method: string;
  path: string;
  body: unknown;
}

export type OfflineAppFixtures = {
  /** Page with clerk stub + hermetic network already installed. */
  page: Page;
  unmockedApiCalls: UnmockedApiCall[];
  pageErrors: string[];
  clerkCounters: () => Promise<ClerkStubCounters>;
  apiTracker: ApiMutation[];
  /**
   * Record a mutation (POST/PUT/PATCH/DELETE) into apiTracker.
   * Domain mocks call this from their route handlers.
   */
  trackMutation: (method: string, path: string, body: unknown) => void;
};

const hasWebApp = hasViteClerkKey();

/**
 * Seed localStorage so WelcomeWalkthrough / WhatsNewModal never block the
 * first paint. Must run before any app script (addInitScript).
 */
async function suppressWalkthroughs(page: Page): Promise<void> {
  await page.addInitScript(
    ({ welcomeKey, whatsNewKey }) => {
      try {
        localStorage.setItem(welcomeKey, '1');
        localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
      } catch {
        // ignore (private mode etc.)
      }
    },
    { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
  );
}

export const test = base.extend<OfflineAppFixtures>({
  unmockedApiCalls: async ({}, use) => {
    const calls: UnmockedApiCall[] = [];
    await use(calls);
  },

  pageErrors: async ({}, use) => {
    const errors: string[] = [];
    await use(errors);
  },

  apiTracker: async ({}, use) => {
    const tracker: ApiMutation[] = [];
    await use(tracker);
  },

  trackMutation: async ({ apiTracker }, use) => {
    await use((method, path, body) => {
      apiTracker.push({ method, path, body });
    });
  },

  clerkCounters: async ({ page }, use) => {
    await use(() => readClerkStubCounters(page));
  },

  page: async (
    { page, baseURL, unmockedApiCalls, pageErrors },
    use,
    testInfo,
  ) => {
    testInfo.skip(
      !hasWebApp,
      'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run offline UI E2E',
    );

    page.on('pageerror', (err) => pageErrors.push(err.message));

    await installClerkStub(page, { signedIn: true });
    await suppressWalkthroughs(page);
    await blockExternalHosts(page, baseURL!);
    // Order matters: catch-all first, then shell (last-wins for overlapping).
    await installApiCatchAll(page, unmockedApiCalls);
    await installShellMocks(page);

    await use(page);

    // Default teardown: no uncaught page errors. Specs that expect errors
    // can clear pageErrors before assertions or use testInfo.annotations.
    expect(pageErrors, 'no uncaught page errors during offline boot').toEqual([]);
  },
});
