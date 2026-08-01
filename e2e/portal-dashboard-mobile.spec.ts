import { test, expect, Page, Route } from '@playwright/test';
import { installClerkStub } from './helpers/clerk-stub';
import { hasViteClerkKey } from './helpers/clerk-key';

/**
 * WS6 (QUALITY-2026-07-12) — mobile/glove hardening for the customer portal
 * dashboard (/portal/:token).
 *
 * Measures what jsdom can't (see PortalDashboard.layout.test.tsx and
 * PortalShell.layout.test.tsx for the CSS class contracts):
 *   - no horizontal overflow at 320px / 390px
 *   - ≥44px tap targets for the tab nav and the reschedule / cancel controls
 *
 * Hermetic: the portal is public (URL-token-gated) and uses plain fetch, so
 * the SPA boots on the CI Clerk-stub (no real Clerk CDN) and every /api/* is
 * route-mocked — no DB or Clerk journey secrets. Mirrors the offline pattern
 * in no-401-storm.spec.ts.
 */

const hasWebApp = hasViteClerkKey();

// Far-future so the dashboard's "upcoming" appointment card renders.
const APPOINTMENT = {
  id: 'appt-e2e-1',
  jobId: 'job-e2e-1',
  status: 'scheduled',
  scheduledStart: '2099-07-01T15:30:00.000Z',
  scheduledEnd: '2099-07-01T16:30:00.000Z',
  arrivalWindowStart: null,
  arrivalWindowEnd: null,
  timezone: 'America/New_York',
};

const CUSTOMER = {
  id: 'cust-e2e-1',
  displayName: 'Sarah Johnson',
  firstName: 'Sarah',
  lastName: 'Johnson',
  email: 'sarah@example.com',
  preferredChannel: 'email',
  timezone: 'America/New_York',
};

const isApiUrl = (url: URL) => url.pathname.startsWith('/api/');

async function blockExternalHosts(page: Page, baseURL: string): Promise<void> {
  const appOrigin = new URL(baseURL).origin;
  await page.route(
    (url) => url.origin !== appOrigin,
    (route) => route.abort(),
  );
}

async function mockPortalApi(page: Page): Promise<void> {
  // Broad /api fallback first (empty 200) so a stray analytics/identity call
  // can't hit the real network; the specific portal route registered after
  // wins for portal URLs (Playwright matches most-recently-added first).
  await page.route(isApiUrl, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/public/portal/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/customer')) return json(CUSTOMER);
    if (url.includes('/invoices')) return json({ invoices: [] });
    if (url.includes('/estimates')) return json({ estimates: [] });
    if (url.includes('/appointments')) return json({ appointments: [APPOINTMENT] });
    return json({});
  });
}

async function openPortal(page: Page, baseURL: string): Promise<void> {
  await installClerkStub(page, { signedIn: false });
  await blockExternalHosts(page, baseURL);
  await mockPortalApi(page);
  await page.goto('/portal/e2e-test-token');
  await expect(page.getByText(/Welcome, Sarah/)).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('customer portal dashboard — mobile layout', () => {
  test.skip(
    !hasWebApp,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI E2E tests',
  );

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('no horizontal overflow', async ({ page, baseURL }) => {
      await openPortal(page, baseURL!);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('every tab-nav control is a ≥44px tap target', async ({ page, baseURL }) => {
      await openPortal(page, baseURL!);
      for (const label of ['Overview', 'Estimates', 'Invoices', 'Jobs', 'Agreements']) {
        const tab = page.getByRole('button', { name: label });
        await expect(tab).toBeVisible();
        const box = await tab.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    });

    test('Reschedule and Cancel controls are ≥44px tall', async ({ page, baseURL }) => {
      await openPortal(page, baseURL!);
      for (const locator of [
        page.getByRole('button', { name: 'Reschedule' }),
        page.getByRole('button', { name: /Cancel this appointment/ }),
      ]) {
        await expect(locator).toBeVisible();
        const box = await locator.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    });
  });

  test.describe('390px (typical phone)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('no horizontal overflow', async ({ page, baseURL }) => {
      await openPortal(page, baseURL!);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
