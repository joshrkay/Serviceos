import { test, expect } from '@playwright/test';
import { hasRealClerkPublishableKey } from './helpers/clerk-key';

/**
 * #872 sweep (settings cluster: #873/#874/#877) — Settings on mobile. The
 * page now carries live-action switch rows behind ConfirmDialogs (#877),
 * a real Service-area editor sheet (#874), and a persistent billing-portal
 * error banner with a re-link state (#873). This pins the mobile bar
 * (CLAUDE.md): no horizontal overflow at 320px and ≥44px tap targets.
 *
 * Gated like the UI smoke tests — these routes are auth-gated, so they need
 * a real running stack with auth (E2E_BASE_URL pointing at a deployed env,
 * or a real Clerk testing pk). `hasRealClerkPublishableKey()` returns false
 * for the CI placeholder key, so on a bare PR runner this describe SKIPS
 * rather than failing to find an authenticated settings page. The
 * verifiable tap-target contracts also have fast jsdom coverage in
 * packages/web/src/components/settings/SettingsPage.live-actions.test.tsx,
 * ServiceAreaSheet.test.tsx and SettingsPage.billing-portal.test.tsx.
 */
const hasStack = hasRealClerkPublishableKey();

test.describe('settings — mobile viewport', () => {
  test.skip(!hasStack, 'Set E2E_BASE_URL or a real Clerk pk to run authenticated UI tests');
  test.use({ viewport: { width: 320, height: 720 } });

  async function expectNoHorizontalOverflow(pageScrollWidth: number, clientWidth: number) {
    // A 1px rounding slack keeps the assertion from flaking on sub-pixel layout.
    expect(pageScrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  }

  test('the settings page fits 320px and live-action switch rows clear 44px (#877)', async ({
    page,
  }) => {
    await page.goto('/settings');
    // Auth-gated route: if it bounced to login, the stack isn't authenticated.
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');

    await expect(page.getByText('Service area', { exact: true }).first()).toBeVisible();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    await expectNoHorizontalOverflow(scrollWidth, clientWidth);

    // Every live-state row renders an explicit switch (#877); each must
    // meet the ≥44px (min-h-11) tap bar.
    const switches = page.getByRole('switch');
    const count = await switches.count();
    for (let i = 0; i < count; i++) {
      const box = await switches.nth(i).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('the Service-area sheet opens, fits 320px, and its inputs clear 44px (#874)', async ({
    page,
  }) => {
    await page.goto('/settings');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');

    await page.getByRole('button', { name: /service area/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Whether the editor or the finish-setup hint rendered, nothing may
    // overflow the 320px viewport.
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    await expectNoHorizontalOverflow(scrollWidth, clientWidth);

    // When the editor's fields are up (tenant finished setup), each input
    // meets the ≥44px (min-h-11) tap bar.
    const radius = page.getByLabel(/radius/i);
    if (await radius.count()) {
      for (const label of [/where you work/i, /radius/i, /zip codes you serve/i]) {
        const box = await page.getByLabel(label).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    }

    // Footer buttons clear the bar too.
    const cancel = page.getByRole('button', { name: 'Cancel' });
    const cancelBox = await cancel.boundingBox();
    expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('the billing-portal error banner fits 320px and drops the retry in the re-link state (#873)', async ({
    page,
  }) => {
    // Force the unrecoverable stale-customer failure — the API envelope's
    // details.reason drives the re-link guidance branch.
    await page.route('**/api/billing/portal-session', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'BILLING_PORTAL_FAILED',
          message: "Stripe couldn't open the billing portal: No such customer",
          details: {
            stripeStatus: 404,
            stripeCode: 'resource_missing',
            reason: 'stripe_customer_missing',
            stripeCustomerId: 'cus_UswJPdKUh7f1eg',
          },
        }),
      }),
    );

    await page.goto('/settings');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');

    const billingRow = page.getByRole('button', { name: /rivet subscription/i });
    if (!(await billingRow.count())) test.skip(true, 'Billing row not rendered in this env');
    await billingRow.click();
    // #877 — the row raises a ConfirmDialog before any live action fires.
    await page.getByTestId('confirm-dialog-confirm').click();

    const banner = page.getByTestId('billing-portal-error');
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('billing-portal-relink')).toBeVisible();
    await expect(page.getByTestId('billing-portal-stale-id')).toHaveText('cus_UswJPdKUh7f1eg');
    // A retry can never succeed here — the affordance must be gone.
    await expect(page.getByTestId('billing-portal-retry')).toHaveCount(0);

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    await expectNoHorizontalOverflow(scrollWidth, clientWidth);
  });
});
