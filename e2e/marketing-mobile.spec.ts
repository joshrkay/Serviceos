import { test, expect, Page } from '@playwright/test';

/**
 * Mobile hardening for the public marketing site (/features, /pricing,
 * /download). The jsdom class contract lives in
 * src/components/marketing/MarketingPages.layout.test.tsx; this measures
 * what jsdom can't:
 *   - no horizontal overflow at 320px (smallest supported phone) or 390px
 *   - the primary "Start free trial" CTA is a ≥44px glove target
 *   - the App Store / Google Play badges are ≥44px tall
 *
 * These pages are public and static (no API or Clerk journey), so the only
 * gate is the app bundle booting — which needs a Clerk publishable key
 * (P0-026 startup guard), same as the other UI specs.
 */

const hasClerk = !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

const MARKETING_ROUTES = ['/features', '/pricing', '/download'] as const;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('marketing site — mobile layout', () => {
  test.skip(
    !hasClerk,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI E2E tests',
  );

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    for (const route of MARKETING_ROUTES) {
      test(`${route} has no horizontal overflow`, async ({ page }) => {
        await page.goto(route);
        await expect(page.getByRole('link', { name: /start free trial/i }).first()).toBeVisible();
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      });
    }

    test('the primary trial CTA is a ≥44px glove target', async ({ page }) => {
      await page.goto('/pricing');
      // Target the pricing CARD CTA by testid — a bare role+name `.first()`
      // matches the sticky header's smaller size="sm" (h-8) CTA first.
      const cta = page.getByTestId('pricing-primary-cta');
      await expect(cta).toBeVisible();
      const box = await cta.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });

    test('the store badges are ≥44px tall', async ({ page }) => {
      await page.goto('/download');
      for (const name of [/download on the app store/i, /get it on google play/i]) {
        const badge = page.getByRole('link', { name }).first();
        await expect(badge).toBeVisible();
        const box = await badge.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    });
  });

  test.describe('390px (typical phone)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    for (const route of MARKETING_ROUTES) {
      test(`${route} has no horizontal overflow`, async ({ page }) => {
        await page.goto(route);
        await expect(page.getByRole('link', { name: /start free trial/i }).first()).toBeVisible();
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      });
    }
  });
});
