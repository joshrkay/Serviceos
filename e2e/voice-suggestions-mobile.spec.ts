import { test, expect, Page } from '@playwright/test';

/**
 * Mobile/glove hardening for the voice "you can say…" suggestions strip (U5),
 * rendered under the idle mic in the bottom VoiceBar.
 *
 * Measures what jsdom can't (the CSS class contract is pinned in
 * VoiceSuggestionsStrip.test.tsx):
 *   - no horizontal overflow at 320px / 390px — the chip row scrolls
 *     internally (overflow-x-auto + min-w-0) instead of widening the bar
 *   - ≥44px tap targets for each suggestion chip (min-h-11)
 *
 * The strip is app chrome behind auth, so this only runs against an
 * authenticated E2E_BASE_URL; without one it skips (the jsdom test still guards
 * the class contract on every run).
 */
const hasAuthedBase = !!process.env.E2E_BASE_URL;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function openWithStrip(page: Page): Promise<void> {
  // Any authenticated app route renders the Shell + idle VoiceBar; the strip is
  // route-aware but always present in the idle phase.
  await page.goto('/jobs');
  await expect(page.getByTestId('voice-suggestions')).toBeVisible();
}

test.describe('voice suggestions strip — mobile layout', () => {
  test.skip(!hasAuthedBase, 'Set E2E_BASE_URL (authenticated) to run the voice-suggestions UI E2E test');

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('the chip row scrolls internally — no horizontal page overflow', async ({ page }) => {
      await openWithStrip(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('each suggestion chip is a ≥44px glove tap target', async ({ page }) => {
      await openWithStrip(page);
      const chips = page.getByTestId('voice-suggestions').getByRole('button');
      const count = await chips.count();
      expect(count).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < count; i++) {
        const box = await chips.nth(i).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    });
  });

  test.describe('390px (typical phone)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('no horizontal overflow', async ({ page }) => {
      await openWithStrip(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
