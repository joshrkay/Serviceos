import { expect } from '@playwright/test';
import { test, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1735 — Settings → Follow-up campaigns sheet at 320px: nothing scrolls
 * sideways and every control clears 44px. The jsdom class contract lives in
 * packages/web/src/components/settings/DripCampaignsSheet.test.tsx; this
 * measures the rendered layout. The drip API is answered by page.route (flag
 * on, one sequence with a long unbroken name), so the run never enrolls or
 * sends anything.
 *
 * Auth-gated: runs under the chromium-devauth project or an authenticated
 * E2E_BASE_URL, and skips otherwise.
 */

const LONG_NAME = `Win back ${'x'.repeat(70)}`;

test.describe('Settings → Follow-up campaigns — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the follow-up campaigns E2E test (or run under the chromium-devauth project)',
    );
  });
  test.use({ viewport: { width: 320, height: 720 } });

  test('the sheet fits 320px and its controls clear 44px', async ({ page }) => {
    await page.route('**/api/drip-campaigns/status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true }) }),
    );
    await page.route('**/api/drip-campaigns/sequences', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 's1',
            name: LONG_NAME,
            targetKind: 'lapsed_customers',
            targetDays: 180,
            status: 'paused',
            steps: [{ channel: 'sms', delayMinutes: 0, body: 'Hi' }],
            stats: { sequenceId: 's1', enrolled: 4, active: 3, completed: 1, booked: 2 },
          },
        ]),
      }),
    );
    await page.goto('/settings');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);
    const open = page.getByRole('button', { name: /follow-up campaigns/i }).first();
    if (!(await open.count())) test.skip(true, 'Signed-in dev user is not an owner in this run');
    await open.click();

    const dialog = page.getByRole('dialog', { name: /Follow-up campaigns/i });
    await expect(dialog.getByText(LONG_NAME)).toBeVisible();
    const buttons = dialog.getByRole('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < count; i++) {
      expect((await buttons.nth(i).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    for (const label of ['Campaign name', 'Step 1 type', 'Step 1 wait (hours)']) {
      const box = await dialog.getByLabel(label).boundingBox();
      expect(box, label).not.toBeNull();
      expect(Math.round(box!.height), label).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width, label).toBeLessThanOrEqual(320);
    }
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    const sheet = await dialog.getByTestId('drip-sheet').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(sheet.sw).toBeLessThanOrEqual(sheet.cw + 1);
  });
});
