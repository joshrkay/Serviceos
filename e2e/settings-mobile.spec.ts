import { expect } from '@playwright/test';
import { test, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';
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
 * a real Clerk testing pk, or the chromium-devauth project —
 * e2e/helpers/dev-auth.ts, D-2). `hasRealClerkPublishableKey()` returns
 * false for the CI placeholder key, so on a bare PR runner this describe
 * SKIPS rather than failing to find an authenticated settings page. The
 * verifiable tap-target contracts also have fast jsdom coverage in
 * packages/web/src/components/settings/SettingsPage.live-actions.test.tsx,
 * ServiceAreaSheet.test.tsx and SettingsPage.billing-portal.test.tsx.
 */

test.describe('settings — mobile viewport', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      hasRealClerkPublishableKey(),
      'Set E2E_BASE_URL or a real Clerk pk to run authenticated UI tests (or run under the chromium-devauth project)',
    );
  });
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
    await dismissWhatsNewModal(page);

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

  test('the call-quality card fits 320px and its grading trigger clears 44px (#1602)', async ({
    page,
  }) => {
    await page.goto('/settings');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

    // Owner-only card (GET /api/voice/quality is tenant:manage). On a fresh
    // stack nothing has been graded, so the empty headline is what renders;
    // a seeded stack shows the pass-rate line instead — either way the card
    // must be there for the owner the dev-auth project signs in as.
    const headline = page.getByText(/No calls graded yet|graded calls passed in the last 7 days/);
    await expect(headline.first()).toBeVisible();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    await expectNoHorizontalOverflow(scrollWidth, clientWidth);

    const trigger = page.getByRole('button', { name: /grade a sample now/i });
    await expect(trigger).toBeVisible();
    const box = await trigger.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(clientWidth + 1);
  });

  test('the Service-area sheet opens, fits 320px, and its inputs clear 44px (#874)', async ({
    page,
  }) => {
    await page.goto('/settings');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

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
    await dismissWhatsNewModal(page);

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

  /**
   * #1402 — under a loaded machine the "what's new" modal can mount after
   * dismissWhatsNewModal's 1.5s wait and swallow the next click. Wait for the
   * page to render first, then give the modal a longer window to appear.
   */
  async function openSettingsSettled(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/settings');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await expect(page.getByText('Service area', { exact: true }).first()).toBeVisible();
    await page
      .getByRole('button', { name: 'Got it', exact: true })
      .click({ timeout: 5_000 })
      .catch(() => undefined);
  }

  // #1402 §13 — the Team members deactivate control and its confirm step fit
  // 320px and clear the 44px tap bar. The roster is stubbed so the row exists
  // regardless of what the dev stack seeded.
  test('Team members: the deactivate control and its confirm step fit 320px at 44px (#1402)', async ({
    page,
  }) => {
    await page.route('**/api/users', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              data: [
                { id: 'u-tech-1402', email: 'alexander.technician-long-name@example.com', role: 'technician', canFieldServe: false },
              ],
            }),
          })
        : route.fallback(),
    );
    await page.route('**/api/users/invitations', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
    );
    await openSettingsSettled(page);

    await page.getByRole('button', { name: /team members/i }).first().click();
    const start = page.getByRole('button', { name: /Deactivate alexander/i });
    if (!(await start.count())) test.skip(true, 'Signed-in dev user is not an owner in this run');
    expect((await start.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    await start.click();
    for (const name of [/Yes, deactivate/i, /^Keep$/i]) {
      const box = await page.getByRole('button', { name }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    }
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    await expectNoHorizontalOverflow(scrollWidth, clientWidth);
  });

  // #1402 §13 — the Payment terms sheet fits 320px; input + buttons clear 44px.
  test('Payment terms sheet fits 320px and its controls clear 44px (#1402)', async ({ page }) => {
    await openSettingsSettled(page);

    await page.getByRole('button', { name: /payment terms/i }).first().click();
    const dialog = page.getByRole('dialog', { name: /Payment terms/i });
    const input = dialog.getByLabel(/Payment due within/i);
    await expect(input).toBeVisible();
    for (const box of [
      await input.boundingBox(),
      await dialog.getByRole('button', { name: 'Save' }).boundingBox(),
      await dialog.getByRole('button', { name: 'Cancel' }).boundingBox(),
    ]) {
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    await expectNoHorizontalOverflow(scrollWidth, clientWidth);
  });
});

