import { test, expect, type Page } from '@playwright/test';
import { installClerkStub } from '../../../e2e/helpers/clerk-stub';

/**
 * Real-layout checks for the spoken setup flow (welcome → "Set up by voice"),
 * signed in. The generic mobile-viewport spec runs signed out, where AuthGate
 * redirects these routes to /sign-in, so it can't measure them.
 *
 * Signed in without network: the shared window.Clerk stub (e2e/helpers/
 * clerk-stub.ts) is adopted by clerk-react on web before any Clerk script loads
 * (with a delayed load(); see signedInWithApi), and every API call is answered by page.route. The export needs
 * EXPO_PUBLIC_API_URL and a syntactically valid EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
 * at build time (see playwright.config.ts); the key is never contacted.
 */

const SESSION = '6f0a8b52-0c64-4d0f-9d43-6f5f2b1a7c11';

const turn = (assistantMessage: string, extra: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  assistantMessage,
  state: 'profile_capture',
  turnCount: 0,
  completed: false,
  proposalIds: [],
  ...extra,
});

const inboxItem = (id: string, summary: string, proposalType: string, confidenceScore: number) => ({
  proposal: { id, summary, proposalType, createdAt: '2026-10-22T00:00:00Z', confidenceScore },
});

interface Api {
  /** Successive replies to POST /api/onboarding/conversation/turn; the last one repeats. */
  turns: Array<{ status: number; body: unknown }>;
  inbox?: unknown[];
}

async function signedInWithApi(page: Page, api: Api): Promise<void> {
  await installClerkStub(page, { signedIn: true });
  // The shared stub's load() resolves in a microtask, so clerk-react emits its
  // "ready" status before ClerkProvider's effect subscribes to it and
  // <ClerkLoaded> never renders (the web app doesn't hit this race). Real
  // Clerk always loads over the network, so a short delay matches production.
  await page.addInitScript(() => {
    const clerk = (window as unknown as { Clerk: { load: () => Promise<void> } }).Clerk;
    clerk.load = () => new Promise((resolve) => setTimeout(resolve, 50));
  });
  let turnIndex = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/onboarding/status') {
      return route.fulfill({ json: { steps: [{ id: 'identity', status: 'pending' }], subscriptionStatus: 'trialing' } });
    }
    if (path === '/api/onboarding/conversation/turn') {
      const reply = api.turns[Math.min(turnIndex, api.turns.length - 1)];
      turnIndex += 1;
      return route.fulfill({ status: reply.status, json: reply.body });
    }
    if (path === '/api/proposals/inbox') return route.fulfill({ json: { data: api.inbox ?? [] } });
    return route.fulfill({ json: {} });
  });
}

async function horizontalOverflowPx(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function expectFitsAndTappable(page: Page, width: number): Promise<void> {
  expect(await horizontalOverflowPx(page)).toBeLessThanOrEqual(1);
  const buttons = page.locator('[role="button"], button');
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await buttons.nth(i).boundingBox();
    if (box && box.height > 0) {
      expect(box.height, `control #${i} height`).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, `control #${i} right edge`).toBeLessThanOrEqual(width + 1);
    }
  }
}

for (const width of [320, 390]) {
  test.describe(`spoken setup @ ${width}px, signed in`, () => {
    test.use({ viewport: { width, height: 760 } });

    test('welcome screen', async ({ page }) => {
      await signedInWithApi(page, { turns: [{ status: 200, body: turn('What do you call the business?') }] });
      await page.goto('/onboarding');
      await expect(page.getByText('Start with your voice', { exact: false })).toBeVisible();
      await expectFitsAndTappable(page, width);
    });

    test('conversation', async ({ page }) => {
      await signedInWithApi(page, { turns: [{ status: 200, body: turn('What do you call the business?') }] });
      await page.goto('/setup-voice');
      await expect(page.getByText('What do you call the business?')).toBeVisible();
      await expect(page.getByText('Hold to talk')).toBeVisible();
      await expectFitsAndTappable(page, width);
    });

    test('a failed turn shows its message and Try again', async ({ page }) => {
      await signedInWithApi(page, { turns: [{ status: 500, body: { error: 'X' } }] });
      await page.goto('/setup-voice');
      await expect(page.getByText("I couldn't reach setup just now", { exact: false })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expectFitsAndTappable(page, width);
    });

    test('review with one item held for Approvals', async ({ page }) => {
      await signedInWithApi(page, {
        turns: [
          { status: 200, body: turn('What do you call the business?') },
          { status: 200, body: turn("That's everything I need.", { turnCount: 1, state: 'completed', completed: true, proposalIds: ['p1', 'p2'] }) },
        ],
        inbox: [
          inboxItem('p1', 'Business profile: Walsh Plumbing and Heating of Greater Cleveland', 'onboarding_tenant_settings', 0.95),
          inboxItem('p2', 'Service: drain cleaning, first hour $150', 'onboarding_service_category', 0.5),
        ],
      });
      await page.goto('/setup-voice');
      await page.getByPlaceholder('Or type your answer').fill('Walsh Plumbing');
      await page.getByText('Send', { exact: true }).click();
      await expect(page.getByText("Here's what I'll set up")).toBeVisible();
      await expect(page.getByText('(needs a closer look)', { exact: false })).toBeVisible();
      await expect(page.getByText('Check in Approvals')).toBeVisible();
      await expectFitsAndTappable(page, width);
    });
  });
}
