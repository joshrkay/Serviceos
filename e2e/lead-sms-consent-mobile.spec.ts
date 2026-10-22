import { test, expect, Page, Route } from '@playwright/test';
import { installClerkStub } from './helpers/clerk-stub';
import { hasViteClerkKey } from './helpers/clerk-key';

/**
 * #1738 — mobile/glove check for the "text me" consent rows on the public
 * intake form (/intake?t=<uuid>, contact step) and the portal's Request
 * service tab (/portal/:token).
 *
 * Measures what jsdom can't (IntakeFormPage.test.tsx and
 * PortalRequestService.test.tsx pin the min-h-11 class contract):
 *   - the consent row is a ≥44px tap target at 320px
 *   - the row's wrapped legal line causes no horizontal overflow at 320px
 *
 * Hermetic: both pages are public and use plain fetch, so the SPA boots on
 * the CI Clerk-stub and every API call is route-mocked (pattern:
 * portal-dashboard-mobile.spec.ts).
 */

const hasWebApp = hasViteClerkKey();
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const CUSTOMER = {
  id: 'cust-e2e-1',
  displayName: 'Sarah Johnson',
  firstName: 'Sarah',
  lastName: 'Johnson',
  email: 'sarah@example.com',
  preferredChannel: 'email',
  timezone: 'America/New_York',
};

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function blockExternalHosts(page: Page, baseURL: string): Promise<void> {
  const appOrigin = new URL(baseURL).origin;
  await page.route(
    (url) => url.origin !== appOrigin,
    (route) => route.abort(),
  );
}

async function boot(page: Page, baseURL: string): Promise<void> {
  await installClerkStub(page, { signedIn: false });
  await blockExternalHosts(page, baseURL);
  // Broad /api fallback first; the specific routes below win (most recent first).
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => json(route, {}));
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function expectTapTarget(page: Page, testId: string): Promise<void> {
  const row = page.getByTestId(testId);
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

test.describe('lead "text me" consent rows — mobile layout', () => {
  test.skip(
    !hasWebApp,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI E2E tests',
  );
  test.use({ viewport: { width: 320, height: 690 } });

  test('intake form contact step: consent row is ≥44px, no overflow', async ({ page, baseURL }) => {
    await boot(page, baseURL!);
    await page.route(`**/public/intake/${TENANT_ID}`, (route) =>
      json(route, {
        businessName: 'Ortega HVAC & Services',
        businessPhone: '(737) 999-0042',
        serviceTypes: [{ verticalType: 'hvac', displayName: 'HVAC Services' }],
      }),
    );
    await page.goto(`/intake?t=${TENANT_ID}`);

    await page.getByTestId('intake-service-hvac').click();
    await page.getByTestId('intake-cta').click();
    await page.getByTestId('intake-description').fill('AC stopped blowing cold air yesterday.');
    await page.getByText('🚨 Emergency').click();
    await page.getByTestId('intake-cta').click();

    await expectTapTarget(page, 'intake-sms-consent');
    await expect(page.getByTestId('intake-sms-consent').getByRole('checkbox')).not.toBeChecked();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('portal Request service tab: consent row is ≥44px, no overflow', async ({ page, baseURL }) => {
    await boot(page, baseURL!);
    await page.route('**/api/public/portal/**', (route) => {
      const url = route.request().url();
      if (url.includes('/customer')) return json(route, CUSTOMER);
      if (url.includes('/invoices')) return json(route, { invoices: [] });
      if (url.includes('/estimates')) return json(route, { estimates: [] });
      if (url.includes('/appointments')) return json(route, { appointments: [] });
      return json(route, {});
    });
    await page.goto('/portal/e2e-test-token');
    await expect(page.getByText(/Welcome, Sarah/)).toBeVisible();
    await page.getByRole('button', { name: 'Request service' }).click();

    await expectTapTarget(page, 'portal-sms-consent');
    await expect(page.getByTestId('portal-sms-consent').getByRole('checkbox')).not.toBeChecked();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
