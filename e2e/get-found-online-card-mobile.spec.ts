import { Page } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1763 (D-044) — the home "Get found online" card at 320px: nothing scrolls
 * sideways, every open item is a ≥44px target inside the viewport, and a tap
 * opens the Settings place that finishes it.
 *
 * The jsdom class contract lives in
 * packages/web/src/components/home/GetFoundOnlineCard.test.tsx; this measures
 * the rendered layout. /api/get-found-online is answered by page.route.
 *
 * Auth-gated: runs under the chromium-devauth project or an authenticated
 * E2E_BASE_URL, and skips otherwise.
 */

const CHECKLIST = {
  items: [
    { id: 'google_listing', status: 'waiting', reason: 'no_location' },
    { id: 'review_link', status: 'current', reason: 'missing' },
  ],
  allDone: false,
  visible: true,
};

async function mockChecklist(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.replace(/\/$/, '') === '/api/get-found-online',
    (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: CHECKLIST }) }),
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('Home → Get found online card — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the Get found online card E2E test (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('open items are glove targets inside 320px, and a tap opens Settings', async ({ page }) => {
      await mockChecklist(page);
      await page.goto('/');
      await dismissWhatsNewModal(page);
      const card = page.getByTestId('get-found-online-card');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('get-found-online-progress')).toHaveText('0 of 2 done');

      const buttons = card.getByRole('button');
      await expect(buttons).toHaveCount(2);
      for (let i = 0; i < 2; i++) {
        const button = buttons.nth(i);
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      await page.getByTestId('get-found-online-item-review_link').getByRole('button').click();
      await expect(page).toHaveURL(/\/settings/);
      await expect(page.locator('#google-review-url')).toBeVisible({ timeout: 20_000 });
    });

    test('#1771 the Google approval card fits 320px with glove-size buttons', async ({ page }) => {
      await page.route(
        (url) => url.pathname.replace(/\/$/, '') === '/api/get-found-online',
        (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              data: {
                items: [{ id: 'google_website', status: 'current', reason: 'not_published' }],
                allDone: false,
                visible: true,
              },
            }),
          }),
      );
      await page.route('**/api/get-found-online/google-website/draft', (route) =>
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              proposalId: 'p-1',
              websiteUri: 'https://a-very-long-business-name-plumbing-and-heating.sites.example.com/some/path',
              bookingUri: 'https://app.example.com/book?t=00000000-0000-0000-0000-000000000000',
            },
          }),
        }),
      );
      await page.goto('/');
      await dismissWhatsNewModal(page);
      const item = page.getByTestId('get-found-online-item-google_website');
      await expect(item).toBeVisible({ timeout: 20_000 });
      await item.getByRole('button').click();

      const approval = page.getByTestId('google-website-approval');
      await expect(approval).toBeVisible();
      for (const id of ['google-website-approve', 'google-website-discard']) {
        const button = page.getByTestId(id);
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
