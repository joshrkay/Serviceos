import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  bootstrapOwner,
  inviteTechnician,
  postJson,
  signInBrowser,
  tenantWallClockToUtc,
  todayInTz,
  type RealOwner,
  type RealTechnician,
} from '../helpers/real-stack-tenant';

/**
 * §8.5 row 5.1 (#1018) — "As Carlos, I want to use this with gloves on in the
 * sun": every field screen at 320px has ≥44px tap targets and no horizontal
 * overflow — at REAL Postgres, with Carlos's own session and his own data.
 *
 * The layout contract `e2e/technician-day-mobile.spec.ts` runs on
 * `chromium-devauth` (in-memory repos). Re-run on the real-Postgres `chromium`
 * pair it SKIPS all four tests: no dev-auth, no seeded technician, no data.
 * And a technician's own day view cannot load under `chromium` at all — its
 * api runs DEV_AUTH_BYPASS, which leaves the DB-authoritative authorization
 * loader unwired, so the SEC-22 guard refuses Carlos's own
 * `/api/dispatch/technician/:id/appointments` (#1086). This spec therefore
 * runs on the real-Postgres pair that wires that loader,
 * `chromium-noauthbypass` (listed in NO_AUTH_BYPASS_SPECS), and provisions
 * everything through the real API: owner + tenant via the signed Clerk
 * webhook, Carlos via invite + join, a customer, a service location, and a
 * job with today's appointment assigned to Carlos.
 *
 * Screens measured: the technician day view (`/technician/day`) and the
 * technician job screen it opens (`/jobs/:id?view=tech`).
 */

const API_URL = process.env.E2E_NOAUTHBYPASS_API_URL ?? 'http://localhost:3002';
const TZ = 'America/Chicago';

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  // 1px slack for sub-pixel rounding.
  expect(scrollWidth, 'horizontal overflow at 320px').toBeLessThanOrEqual(clientWidth + 1);
}

async function expectGloveTarget(page: Page, locator: ReturnType<Page['getByTestId']>, label: string) {
  await expect(locator, `${label} visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} has a box`).not.toBeNull();
  expect(box!.height, `${label} height ≥ 44px`).toBeGreaterThanOrEqual(44);
}

test.describe('5.1 — field screens meet the glove/daylight contract at 320px, real Postgres', () => {
  const canRun = !process.env.E2E_BASE_URL && hasViteClerkKey() && process.env.E2E_USE_TEST_DB === 'true' && !!process.env.DATABASE_URL;
  test.skip(!canRun, 'Needs the local webServer pairs against a real Postgres (E2E_USE_TEST_DB=true, DATABASE_URL).');
  test.use({ viewport: { width: 320, height: 720 } });

  let api: APIRequestContext;
  let pool: Pool;
  let owner: RealOwner;
  let carlos: RealTechnician;
  let jobId: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // seeding through the real API is slow under load
    if (!canRun) return;
    api = await pwRequest.newContext({ timeout: 60_000 });
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    owner = await bootstrapOwner(api, API_URL, pool, 'glove', TZ);
    carlos = await inviteTechnician(api, API_URL, owner, 'carlos-glove');
    const customer = await postJson(api, `${API_URL}/api/customers`, owner.headers, {
      firstName: 'Glove',
      lastName: `Customer ${Date.now()}`,
      primaryPhone: '512-555-0151',
      preferredChannel: 'sms',
      smsConsent: true,
    });
    const location = await postJson(api, `${API_URL}/api/locations`, owner.headers, {
      customerId: customer.id,
      street1: '51 Daylight Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      isPrimary: true,
    });
    const job = await postJson(api, `${API_URL}/api/jobs`, owner.headers, {
      customerId: customer.id,
      locationId: location.id,
      summary: 'Condenser coil clean',
      priority: 'normal',
      scheduledStart: tenantWallClockToUtc(todayInTz(TZ), '14:00', TZ).toISOString(),
      durationMin: 60,
      timezone: TZ,
      technicianId: carlos.techId,
    });
    jobId = job.id;
  });

  test.afterAll(async () => {
    await api?.dispose();
    await pool?.end();
  });

  test('Carlos\'s day view and job screen fit 320px and every primary control is a ≥44px glove target', async ({ page, baseURL }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await signInBrowser(page, baseURL!, carlos.sub, carlos.token);

    await page.goto('/technician/day');
    await expect(page.getByTestId('technician-day-view')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('technician-day-error')).toHaveCount(0, { timeout: 15_000 });
    const card = page.getByTestId('technician-day-appointment').first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expectNoHorizontalOverflow(page);

    await expectGloveTarget(page, page.getByTestId('technician-day-prev'), 'Previous day');
    await expectGloveTarget(page, page.getByTestId('technician-day-next'), 'Next day');
    await expectGloveTarget(page, card.getByTestId('technician-day-on-my-way'), 'On my way');
    const viewJob = card.getByTestId('technician-day-view-job');
    await expectGloveTarget(page, viewJob, 'View job');
    await page.screenshot({ path: 'docs/audit/lane-reports/1015-1018-rows-rung5/5.1-day-view-320.png', fullPage: true });

    await viewJob.click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}`), { timeout: 20_000 });
    const addPhoto = page.getByRole('button', { name: /add photo/i });
    await expect(addPhoto).toBeVisible({ timeout: 15_000 });
    const box = await addPhoto.boundingBox();
    expect(box!.height, 'Add photo height ≥ 44px').toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: 'docs/audit/lane-reports/1015-1018-rows-rung5/5.1-tech-job-320.png', fullPage: true });

    expect(pageErrors, 'no uncaught page errors on the field screens').toEqual([]);
  });
});
