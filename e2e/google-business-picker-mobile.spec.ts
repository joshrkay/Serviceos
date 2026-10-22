import { Page } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1762 (D-044) — Settings → Google Business location picker at 320px:
 * nothing scrolls sideways and every location is a ≥44px target inside the
 * viewport, including a long title and address.
 *
 * The jsdom class contract lives in
 * packages/web/src/components/settings/GoogleBusinessSheet.test.tsx; this
 * measures the rendered layout. Every /api/googlebusiness-integrations* call
 * is answered by page.route, so the run never talks to Google.
 *
 * Auth-gated: runs under the chromium-devauth project or an authenticated
 * E2E_BASE_URL, and skips otherwise.
 */

const LOCATIONS = [
  {
    accountId: '123',
    locationId: '999',
    title: 'Acme Plumbing, Heating & Air Conditioning of Greater Round Rock',
    address: '12345 North Interstate Highway 35 Frontage Road, Suite 400, Round Rock, TX',
    placeId: 'ChIJ1',
    reviewUrl: 'https://g.page/r/review-999',
  },
  {
    accountId: '456',
    locationId: '555',
    title: 'Acme North',
    address: null,
    placeId: 'ChIJ2',
    reviewUrl: 'https://g.page/r/review-555',
  },
];

function integration(overrides: Record<string, unknown>) {
  return {
    id: 'int-1',
    provider: 'google_business',
    status: 'full_readiness',
    accountId: null,
    locationId: null,
    locationTitle: null,
    reviewUrl: null,
    locationState: 'needs_pick',
    updatedAt: '2026-10-22T00:00:00Z',
    lastSuccessfulPollAt: null,
    backoffUntil: null,
    ...overrides,
  };
}

async function mockGoogleBusinessApi(page: Page): Promise<{ chosen: () => unknown }> {
  let chosen: unknown = null;
  await page.route(
    (url) => url.pathname.startsWith('/api/googlebusiness-integrations'),
    async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
      const json = (body: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/googlebusiness-integrations') {
        await json({ data: integration({}) });
        return;
      }
      if (path === '/api/googlebusiness-integrations/google/locations') {
        await json({ data: LOCATIONS });
        return;
      }
      if (path === '/api/googlebusiness-integrations/google/location') {
        chosen = route.request().postDataJSON();
        await json({
          data: integration({
            accountId: '456',
            locationId: '555',
            locationTitle: 'Acme North',
            reviewUrl: 'https://g.page/r/review-555',
            locationState: 'connected',
          }),
          reviewUrlFilled: true,
        });
        return;
      }
      await route.fulfill({ status: 404, body: '' });
    },
  );
  return { chosen: () => chosen };
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('Settings → Google Business location picker — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the Google Business picker E2E test (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('every location is a glove target inside 320px, and a tap saves it', async ({ page }) => {
      const api = await mockGoogleBusinessApi(page);
      // The OAuth return URL opens the sheet, exactly as Google's redirect does.
      await page.goto('/settings?googlebusiness_connected=1');
      await dismissWhatsNewModal(page);
      await expect(page.getByTestId('googlebusiness-location-picker')).toBeVisible({ timeout: 20_000 });

      const options = page.getByTestId('googlebusiness-location-option');
      await expect(options).toHaveCount(2);
      for (let i = 0; i < 2; i++) {
        const option = options.nth(i);
        await option.scrollIntoViewIfNeeded();
        const box = await option.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      await options.nth(1).click();
      await expect(page.getByText('Business location: Acme North')).toBeVisible();
      expect(api.chosen()).toEqual({ accountId: '456', locationId: '555' });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
