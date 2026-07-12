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

const ROUTES = ['/', '/sign-in', '/customers/new', '/schedule', '/digest'];

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
