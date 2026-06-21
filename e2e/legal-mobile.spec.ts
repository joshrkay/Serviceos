import { test, expect, Page } from '@playwright/test';

/**
 * Mobile layout hardening for the public legal pages (/privacy, /terms).
 *
 * Apple App Store Review requires a reachable Privacy Policy URL, and the pages
 * are linked from the marketing footer, so they must render cleanly on the
 * smallest supported phone. Measures what jsdom can't (see LegalPage.test.tsx
 * for the CSS class contract): no horizontal overflow at 320px / 390px, and the
 * heading is visible. No backend or view-token is needed — the pages are static.
 */

// Same gate as the other UI specs — main.tsx throws without a Clerk key.
const hasClerk = !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

const PAGES: Array<{ path: string; heading: RegExp }> = [
  { path: '/privacy', heading: /privacy policy/i },
  { path: '/terms', heading: /terms of service/i },
];

test.describe('legal pages — mobile layout', () => {
  test.skip(
    !hasClerk,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI E2E tests',
  );

  for (const width of [320, 390]) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height: 800 } });

      for (const { path, heading } of PAGES) {
        test(`${path} renders with no horizontal overflow`, async ({ page }) => {
          await page.goto(path);
          await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
          expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
        });
      }
    });
  }
});
