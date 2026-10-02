import { Page } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1563 — Settings → Phone (/settings/phone) at 320px: nothing scrolls
 * sideways, and every control of the change-number flow (Change number, area
 * code, Search, a candidate, Switch to…, Keep my current number) is a ≥44px
 * target inside the viewport.
 *
 * The jsdom class contract lives in
 * packages/web/src/components/settings/PhoneSettingsPage.test.tsx; this
 * measures the rendered layout. Every /api/onboarding/phone* call is answered
 * by page.route, so the run never searches or buys a real number and never
 * touches the dev tenant's line.
 *
 * Auth-gated: runs under the chromium-devauth project or an authenticated
 * E2E_BASE_URL, and skips otherwise.
 */

const LINE = {
  state: 'active',
  phoneNumber: '+15125550123',
  pendingNumber: null,
  changingTo: null,
  changeError: null,
  lastError: null,
};

async function mockPhoneApi(page: Page): Promise<{ changed: () => string | null }> {
  let changedTo: string | null = null;
  await page.route(
    (url) => url.pathname.startsWith('/api/onboarding/phone'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/onboarding/phone') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(changedTo ? { ...LINE, changingTo: changedTo } : LINE),
        });
        return;
      }
      if (path === '/api/onboarding/phone/available') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            numbers: [
              { phoneNumber: '+17375550111', locality: 'Round Rock', region: 'TX' },
              { phoneNumber: '+17375550112', locality: 'Round Rock', region: 'TX' },
            ],
          }),
        });
        return;
      }
      if (path === '/api/onboarding/phone/change') {
        changedTo = (route.request().postDataJSON() as { phoneNumber: string }).phoneNumber;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, enqueued: true, phoneNumber: changedTo }),
        });
        return;
      }
      await route.fulfill({ status: 404, body: '' });
    },
  );
  return { changed: () => changedTo };
}

async function openPage(page: Page): Promise<void> {
  await page.goto('/settings/phone');
  await dismissWhatsNewModal(page);
  // Generous: the lazy route chunk compiles on first hit under the dev server.
  await expect(page.getByTestId('phone-settings')).toBeVisible({ timeout: 20_000 });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function expectGloveTarget(page: Page, name: string | RegExp, width = 320): Promise<void> {
  const target = page.getByRole('button', { name }).first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box, String(name)).not.toBeNull();
  expect(Math.round(box!.height), String(name)).toBeGreaterThanOrEqual(44);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, String(name)).toBeLessThanOrEqual(width);
}

test.describe('Settings → Phone — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the Settings → Phone E2E test (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('shows the number with no horizontal overflow; Change number is a glove target', async ({ page }) => {
      await mockPhoneApi(page);
      await openPage(page);
      await expect(page.getByText('(512) 555-0123')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await expectGloveTarget(page, 'Change number');
    });

    test('the whole change-number flow stays ≥44px and inside 320px', async ({ page }) => {
      const api = await mockPhoneApi(page);
      await openPage(page);
      await page.getByRole('button', { name: 'Change number' }).click();

      const area = page.getByLabel('Area code');
      const areaBox = await area.boundingBox();
      expect(Math.round(areaBox!.height)).toBeGreaterThanOrEqual(44);
      await area.fill('737');
      await expectGloveTarget(page, /^Search$/);
      await page.getByRole('button', { name: /^Search$/ }).click();

      await expectGloveTarget(page, /\(737\) 555-0111/);
      await page.getByRole('button', { name: /\(737\) 555-0111/ }).click();
      await expectGloveTarget(page, /Switch to \(737\) 555-0111/);
      await expectGloveTarget(page, 'Keep my current number');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      await page.getByRole('button', { name: /Switch to \(737\) 555-0111/ }).click();
      await expect(page.getByText(/Switching to \(737\) 555-0111/)).toBeVisible();
      expect(api.changed()).toBe('+17375550111');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
