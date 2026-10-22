import { test, expect, type Page } from '@playwright/test';

/**
 * Real-layout viewport checks for the mobile web export — the half of the
 * CLAUDE.md mobile-UI rule that jsdom can't measure: no horizontal overflow at
 * 320px. The tap-target half is also covered here against real layout, and in
 * the jsdom screen contract tests (src/screens/*).
 */

async function appRendered(page: Page): Promise<boolean> {
  return page.evaluate(() => (document.body.innerText || '').trim().length > 0);
}

async function horizontalOverflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

const ROUTES = ['/', '/today', '/sign-in', '/customers/new', '/schedule', '/digest'];

/**
 * Signed-in setup screens. Signed out, AuthGate redirects them to /sign-in, so a
 * plain overflow check would measure the sign-in page and pass for the wrong
 * reason. These assert the screen was actually reached and skip (saying so)
 * when it wasn't: there is no signed-in fixture for this export yet.
 */
const SIGNED_IN_ROUTES: { route: string; heading: string }[] = [
  { route: '/onboarding', heading: 'Start with your voice' },
  { route: '/setup-voice', heading: 'Set up by voice' },
];

for (const width of [320, 390]) {
  test.describe(`mobile web @ ${width}px`, () => {
    test.use({ viewport: { width, height: 760 } });

    for (const route of ROUTES) {
      test(`no horizontal overflow on ${route}`, async ({ page }) => {
        await page.goto(route, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        expect(await horizontalOverflowPx(page)).toBeLessThanOrEqual(1);
      });
    }

    for (const { route, heading } of SIGNED_IN_ROUTES) {
      test(`no horizontal overflow on ${route} (skips unless signed in)`, async ({ page }) => {
        await page.goto(route, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        const reached = new URL(page.url()).pathname === route && (await page.getByText(heading).count()) > 0;
        test.skip(!reached, `${route} redirected (not signed in) — no signed-in fixture for the web export`);
        expect(await horizontalOverflowPx(page)).toBeLessThanOrEqual(1);
      });
    }

    test('actionable controls are >=44px tall (skips if Clerk did not load)', async ({ page }) => {
      await page.goto('/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
      test.skip(
        !(await appRendered(page)),
        'app shell is blank — no reachable Clerk instance in this environment',
      );

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
    });
  });
}
