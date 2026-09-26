import { expect } from '@playwright/test';
import { test, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';
import { hasRealClerkPublishableKey } from './helpers/clerk-key';

/**
 * #1281 — archiving a customer asks for confirmation, and an archived
 * customer can be found (Archived view) and restored. Pins the mobile bar
 * (CLAUDE.md): no horizontal overflow at 320px, ≥44px tap targets on the new
 * controls. jsdom class-contract coverage lives in
 * packages/web/src/pages/customers/CustomerDetail.archive.test.tsx and
 * packages/web/src/components/customers/CustomersPage.test.tsx.
 *
 * The archive/restore flow creates its own customer through the dev-auth API
 * (so it never mutates the shared devauth-setup seed), and therefore runs only
 * under the chromium-devauth project.
 */

const DEV_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJkZXZfb3duZXIiLCJzaWQiOiJkZXYtc2Vzc2lvbiIsInJvbGUiOiJvd25lciJ9.x';

test.describe('customer archive + restore — mobile viewport', () => {
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
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  }

  test('the customer list fits 320px and its Archived toggle clears 44px', async ({ page }) => {
    await page.goto('/customers');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

    const toggle = page.getByRole('button', { name: /Archived/ });
    await expect(toggle).toBeVisible();
    expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);
  });

  test('archive asks first, then the customer is found under Archived and restored', async ({
    page,
    request,
    devAuthActive,
  }) => {
    test.skip(!devAuthActive, 'Creates its own customer through the dev-auth API');
    const apiURL = process.env.E2E_DEVAUTH_API_URL ?? 'http://127.0.0.1:3001';
    const lastName = `Archive ${Date.now()}`;
    const created = await request.post(`${apiURL}/api/customers`, {
      headers: { Authorization: `Bearer ${DEV_TOKEN}` },
      data: { firstName: 'Casey', lastName, preferredChannel: 'phone', smsConsent: false },
    });
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };

    await page.goto(`/customers/${id}`);
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(`Archive Casey ${lastName}?`);
    await expectNoHorizontalOverflow(page);
    const confirm = page.getByTestId('confirm-dialog-confirm');
    expect((await confirm.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await confirm.click();

    await expect(page).toHaveURL(/\/customers$/);
    await expect(page.getByText(`Casey ${lastName}`)).toHaveCount(0);

    await page.getByRole('button', { name: /Archived/ }).click();
    await page.getByText(`Casey ${lastName}`).click();

    const restore = page.getByRole('button', { name: 'Restore customer' });
    await expect(restore).toBeVisible();
    expect((await restore.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);
    await restore.click();
    await expect(page.getByTestId('customer-archived-banner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
  });
});
