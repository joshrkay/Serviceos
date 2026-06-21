import { test, expect, type Page } from '@playwright/test';

/**
 * Real-layout viewport checks for the U9 error-UX layer on the mobile web export.
 * The jsdom class-contract tests pin the tap-target (`min-h-11`) and "no fixed
 * width" class invariants on Toast / OfflineBanner / ErrorBoundary / ErrorState;
 * this is the half jsdom can't measure: that those surfaces, mounted in the root
 * layout above the routed tree, introduce no horizontal overflow at the 320px
 * floor, and that any rendered control still meets the >=44px glove target.
 *
 * Same Clerk-gating caveat as mobile-viewport.spec.ts: content (and thus the
 * error surfaces) renders only when EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY points at a
 * reachable Clerk instance (CI). Without it the export serves a blank shell — the
 * document-level no-overflow invariant still holds and is asserted; content and
 * tap-target checks skip with a clear reason.
 */

async function appRendered(page: Page): Promise<boolean> {
  return page.evaluate(() => (document.body.innerText || '').trim().length > 0);
}

async function horizontalOverflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('mobile error-UX @ 320px', () => {
  test.use({ viewport: { width: 320, height: 760 } });

  test('the root error-UX layer adds no horizontal overflow', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // The OfflineBanner / Toast positioning wrappers are full-width-inset (no
    // fixed pixel width), so the document must not scroll horizontally at 320px.
    // <= 1px tolerates sub-pixel rounding; a real overflow is many px.
    expect(await horizontalOverflowPx(page)).toBeLessThanOrEqual(1);
  });

  test('rendered controls meet the >=44px glove target and stay in-bounds', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    test.skip(
      !(await appRendered(page)),
      'app shell is blank — no reachable Clerk instance in this environment',
    );

    // react-native-web renders Pressable (incl. the Toast dismiss and the
    // ErrorBoundary "Try again") as role="button"; every actionable control on
    // the reached screen must meet the glove target and fit the 320px width.
    const buttons = page.locator('[role="button"], button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      if (box && box.height > 0) {
        expect(box.height, `control #${i} height`).toBeGreaterThanOrEqual(44);
        expect(box.x + box.width, `control #${i} right edge`).toBeLessThanOrEqual(321);
      }
    }
  });
});
