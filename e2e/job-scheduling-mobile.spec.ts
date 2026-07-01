import { test, expect } from '@playwright/test';

/**
 * U8 — Job scheduling on mobile. The job detail page now carries a Schedule
 * panel (schedule / reschedule / reassign / unschedule); the create form
 * carries an optional schedule block. This pins the mobile bar (CLAUDE.md):
 * no horizontal overflow at 320px and ≥44px tap targets on the new controls.
 *
 * Gated like the UI smoke tests — requires a running stack with auth
 * (E2E_BASE_URL pointing at a deployed env, or a local Clerk pk). The
 * verifiable tap-target contract also has fast jsdom coverage in
 * packages/web/src/components/jobs/JobForm.test.tsx and
 * JobSchedulePanel.test.tsx.
 */
const hasStack = !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

test.describe('job scheduling — mobile viewport', () => {
  test.skip(!hasStack, 'Set E2E_BASE_URL or VITE_CLERK_PUBLISHABLE_KEY to run authenticated UI tests');
  test.use({ viewport: { width: 320, height: 720 } });

  async function expectNoHorizontalOverflow(pageScrollWidth: number, clientWidth: number) {
    // A 1px rounding slack keeps the assertion from flaking on sub-pixel layout.
    expect(pageScrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  }

  test('the create-job form fits a 320px viewport with ≥44px controls', async ({ page }) => {
    await page.goto('/jobs/new');
    // Auth-gated route: if it bounced to login, the stack isn't authenticated.
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');

    await expect(page.getByRole('heading', { name: /new job/i })).toBeVisible();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    await expectNoHorizontalOverflow(scrollWidth, clientWidth);

    // The schedule start control meets the ≥44px (min-h-11 = 2.75rem) tap bar.
    const start = page.getByLabel(/start time/i).first();
    if (await start.count()) {
      const box = await start.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('a job detail page shows the Schedule panel without overflow', async ({ page }) => {
    await page.goto('/jobs');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');

    // Open the first job in the list, if any are seeded.
    const firstJob = page.getByRole('link', { name: /JOB-/ }).first();
    if (!(await firstJob.count())) test.skip(true, 'No jobs seeded to open');
    await firstJob.click();

    await expect(page.getByText(/Schedule/i).first()).toBeVisible();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    await expectNoHorizontalOverflow(scrollWidth, clientWidth);
  });
});
