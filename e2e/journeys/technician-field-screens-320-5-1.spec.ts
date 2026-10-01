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
 *
 * T2 / T3 (a neighbour in the same run): a second tenant, configured in a
 * DIFFERENT timezone (Pacific/Auckland vs Carlos's America/Chicago), has its
 * own technician and its own appointment today with a long customer name.
 * Carlos's day is bucketed in HIS tenant's timezone, so the neighbour's
 * configuration and data do not change his answer: his day view lists
 * exactly his one appointment, never the neighbour's, and still fits 320px;
 * the neighbour's technician sees exactly its own. The day view reads the
 * tenant's timezone from `tenant_settings` (dispatch/routes.ts →
 * `settingsRepo.findByTenant`), so a settings lookup that loses its tenant
 * predicate buckets Carlos's day in Auckland and his 14:00 card vanishes —
 * the planted fault this leg was proven red against.
 */

const API_URL = process.env.E2E_NOAUTHBYPASS_API_URL ?? 'http://localhost:3002';
const TZ = 'America/Chicago';
const NEIGHBOUR_TZ = 'Pacific/Auckland';
const NEIGHBOUR_CUSTOMER = 'Nerida Neighbourhood-Farquharson-Whitcombe';

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
  let customerName: string;
  let neighbourTech: RealTechnician;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // seeding through the real API is slow under load
    if (!canRun) return;
    api = await pwRequest.newContext({ timeout: 60_000 });
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    owner = await bootstrapOwner(api, API_URL, pool, 'glove', TZ);
    carlos = await inviteTechnician(api, API_URL, owner, 'carlos-glove');
    customerName = `Glove Customer ${Date.now()}`;
    const customer = await postJson(api, `${API_URL}/api/customers`, owner.headers, {
      firstName: 'Glove',
      lastName: customerName.slice('Glove '.length),
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

    // T2/T3 — the neighbour, seeded AFTER tenant A, in a different timezone,
    // with its own technician and its own appointment today (its local 14:00).
    const neighbour = await bootstrapOwner(api, API_URL, pool, 'glove-nb', NEIGHBOUR_TZ);
    neighbourTech = await inviteTechnician(api, API_URL, neighbour, 'tech-glove-nb');
    const [nbFirst, ...nbLast] = NEIGHBOUR_CUSTOMER.split(' ');
    const nbCustomer = await postJson(api, `${API_URL}/api/customers`, neighbour.headers, {
      firstName: nbFirst,
      lastName: nbLast.join(' '),
      primaryPhone: '512-555-0152',
    });
    const nbLocation = await postJson(api, `${API_URL}/api/locations`, neighbour.headers, {
      customerId: nbCustomer.id,
      street1: '52 Neighbour Parade',
      city: 'Auckland',
      state: 'AUK',
      postalCode: '1010',
      isPrimary: true,
    });
    await postJson(api, `${API_URL}/api/jobs`, neighbour.headers, {
      customerId: nbCustomer.id,
      locationId: nbLocation.id,
      summary: 'Neighbour heat-pump service',
      priority: 'normal',
      scheduledStart: tenantWallClockToUtc(todayInTz(NEIGHBOUR_TZ), '14:00', NEIGHBOUR_TZ).toISOString(),
      durationMin: 60,
      timezone: NEIGHBOUR_TZ,
      technicianId: neighbourTech.techId,
    });
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

  test('T2/T3 — a differently-configured neighbour with its own day does not change Carlos\'s day view: exactly his one card, still 320px-clean; the neighbour sees only its own', async ({ page, browser, baseURL }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await signInBrowser(page, baseURL!, carlos.sub, carlos.token);

    await page.goto('/technician/day');
    await expect(page.getByTestId('technician-day-view')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('technician-day-error')).toHaveCount(0, { timeout: 15_000 });
    const cards = page.getByTestId('technician-day-appointment');
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    await expect(cards, 'Carlos sees exactly his own appointment').toHaveCount(1);
    await expect(cards.first()).toContainText(customerName);
    await expect(page.getByText(NEIGHBOUR_CUSTOMER)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectGloveTarget(page, cards.first().getByTestId('technician-day-on-my-way'), 'On my way (with a neighbour)');

    const nbPage = await (await browser.newContext({ viewport: { width: 320, height: 720 } })).newPage();
    nbPage.on('pageerror', (err) => pageErrors.push(err.message));
    await signInBrowser(nbPage, baseURL!, neighbourTech.sub, neighbourTech.token);
    await nbPage.goto('/technician/day');
    await expect(nbPage.getByTestId('technician-day-view')).toBeVisible({ timeout: 15_000 });
    const nbCards = nbPage.getByTestId('technician-day-appointment');
    await expect(nbCards.first()).toBeVisible({ timeout: 15_000 });
    await expect(nbCards, 'the neighbour sees exactly its own appointment').toHaveCount(1);
    await expect(nbCards.first()).toContainText(NEIGHBOUR_CUSTOMER);
    await expect(nbPage.getByText(customerName)).toHaveCount(0);
    await expectNoHorizontalOverflow(nbPage);
    await page.screenshot({ path: 'docs/audit/lane-reports/t2-legs-rung5/5.1-carlos-day-with-neighbour-320.png', fullPage: true });
    await nbPage.screenshot({ path: 'docs/audit/lane-reports/t2-legs-rung5/5.1-neighbour-day-320.png', fullPage: true });

    expect(pageErrors, 'no uncaught page errors on either tenant\'s day view').toEqual([]);
  });
});
