import { Page } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1764 (D-044) — Settings → Google Business "create your Google profile"
 * walkthrough (the no-location state) at 320px: the steps, both Google links
 * and the re-check button are ≥44px targets inside the viewport and nothing
 * scrolls sideways; a re-check that finds a location hands off to the picker.
 *
 * The jsdom class contract lives in
 * packages/web/src/components/settings/GoogleBusinessSheet.test.tsx. Every
 * /api/googlebusiness-integrations* call is answered by page.route.
 *
 * Auth-gated: runs under the chromium-devauth project or an authenticated
 * E2E_BASE_URL, and skips otherwise.
 */

const INTEGRATION = {
  id: 'int-1',
  provider: 'google_business',
  status: 'full_readiness',
  accountId: null,
  locationId: null,
  locationTitle: null,
  reviewUrl: null,
  locationState: 'no_location',
  updatedAt: '2026-10-22T00:00:00Z',
  lastSuccessfulPollAt: null,
  backoffUntil: null,
};

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('Settings → Google profile walkthrough — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the Google profile walkthrough E2E test (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('walkthrough targets fit 320px, and a re-check hands off to the picker', async ({ page }) => {
      let found = false;
      await page.route(
        (url) => url.pathname.startsWith('/api/googlebusiness-integrations'),
        async (route) => {
          const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
          const json = (body: unknown) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
          if (path === '/api/googlebusiness-integrations') {
            await json({ data: INTEGRATION });
          } else if (path === '/api/googlebusiness-integrations/google/locations') {
            await json({
              data: found
                ? [{ accountId: '123', locationId: '999', title: 'Acme Plumbing', address: null, placeId: 'p', reviewUrl: null }]
                : [],
            });
          } else {
            await route.fulfill({ status: 404, body: '' });
          }
        },
      );
      await page.goto('/settings?googlebusiness_connected=1');
      await dismissWhatsNewModal(page);
      await expect(page.getByTestId('googlebusiness-no-location')).toBeVisible({ timeout: 20_000 });

      for (const id of ['googlebusiness-create-profile', 'googlebusiness-verify-help', 'googlebusiness-check-again']) {
        const el = page.getByTestId(id);
        await el.scrollIntoViewIfNeeded();
        const box = await el.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
      await expect(page.getByTestId('googlebusiness-create-profile')).toHaveAttribute(
        'href',
        'https://business.google.com/create',
      );
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      found = true;
      await page.getByTestId('googlebusiness-check-again').click();
      await expect(page.getByTestId('googlebusiness-location-option')).toHaveCount(1);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
