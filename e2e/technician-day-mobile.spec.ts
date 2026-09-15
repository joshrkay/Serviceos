import { expect } from '@playwright/test';
import { test, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';
import { hasRealClerkPublishableKey } from './helpers/clerk-key';

/**
 * §8.5 row 5.1 (ticket #1018) — glove/daylight 320px contract for the
 * technician day view (`/technician/day` — routes.ts).
 *
 * G1 (#1006): 5.1 was NO-COMMAND — no Playwright viewport spec existed for
 * the field screens. Measures what jsdom can't (see
 * TechnicianDayView.layout.test.tsx / TechJobView.layout.test.tsx for the
 * CSS class contract): no horizontal overflow at 320px, and ≥44px tap
 * targets on the primary actions a technician taps in the field.
 *
 * Same gate as job-scheduling-mobile.spec.ts — auth-gated route, needs a
 * real running stack (E2E_BASE_URL, a real Clerk pk, or the
 * chromium-devauth project, D-2). This is a LAYOUT-ONLY contract, not a
 * rung-5 reachability claim: per research #1004 (recorded on map #995),
 * chromium-devauth forces in-memory repos + TELEPHONY_ENABLED=false, so a
 * rung-5 claim on it would fail "mocked is not proven" — no rung is
 * claimed here (see docs/audit/lane-reports/1018-execute.md).
 */

test.describe('technician day view — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      hasRealClerkPublishableKey(),
      'Set E2E_BASE_URL or a real Clerk pk to run authenticated UI tests (or run under the chromium-devauth project)',
    );
  });
  test.use({ viewport: { width: 320, height: 720 } });

  async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    // A 1px rounding slack keeps the assertion from flaking on sub-pixel layout.
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  }

  test('the day view fits a 320px viewport with no horizontal overflow', async ({ page }) => {
    await page.goto('/technician/day');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

    const view = page.getByTestId('technician-day-view');
    if (!(await view.count())) {
      test.skip(true, 'No technician profile / not on the technician day view in this run');
    }
    await expect(view).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('the Previous/Next day-nav controls meet the ≥44px glove target', async ({ page }) => {
    await page.goto('/technician/day');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

    const prev = page.getByTestId('technician-day-prev');
    if (!(await prev.count())) test.skip(true, 'No technician profile in this run');

    for (const testId of ['technician-day-prev', 'technician-day-next']) {
      const control = page.getByTestId(testId);
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('an appointment card\'s View job / On my way controls meet the ≥44px glove target', async ({ page }) => {
    await page.goto('/technician/day');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

    const card = page.getByTestId('technician-day-appointment').first();
    if (!(await card.count())) test.skip(true, 'No appointments seeded for today in this run');

    const onMyWay = card.getByTestId('technician-day-on-my-way');
    await expect(onMyWay).toBeVisible();
    const onMyWayBox = await onMyWay.boundingBox();
    expect(onMyWayBox).not.toBeNull();
    expect(onMyWayBox!.height).toBeGreaterThanOrEqual(44);

    const viewJob = card.getByTestId('technician-day-view-job');
    if (await viewJob.count()) {
      const box = await viewJob.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalOverflow(page);
  });

  test('the technician job-detail screen (view=tech) fits 320px, Add photo meets the glove target', async ({ page }) => {
    await page.goto('/technician/day');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

    const viewJob = page.getByTestId('technician-day-view-job').first();
    if (!(await viewJob.count())) test.skip(true, 'No appointments with a job to open in this run');
    await viewJob.click();

    await expectNoHorizontalOverflow(page);

    const addPhoto = page.getByRole('button', { name: /add photo/i });
    if (await addPhoto.count()) {
      await expect(addPhoto).toBeVisible();
      const box = await addPhoto.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
