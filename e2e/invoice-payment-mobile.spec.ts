import { test, expect, Page } from '@playwright/test';
import { hasRealClerkPublishableKey } from './helpers/clerk-key';

/**
 * B7.5 (PR review, FINDING B — invoice half) — mobile/glove hardening for
 * the public invoice pay page (/pay/:id), mirroring
 * e2e/estimate-approval-mobile.spec.ts (the estimate-side fix in ea46e5a).
 *
 * Measures what jsdom can't (see InvoicePaymentPage.layout.test.tsx for the
 * CSS class contract):
 *   - the descriptive unit renders beside the quantity without introducing
 *     horizontal overflow at 320px
 *   - the unit adds height, not width — it does not starve the description
 *     column the way an unconstrained addition would
 *   - the money column stays inside the viewport, unaffected by the unit
 *
 * The backend is mocked via page.route — the page is public
 * (view-token-gated) — so no DB or Clerk journey secrets are needed beyond
 * the UI bundle booting with a real Clerk publishable key (CI placeholder
 * is not enough, hence hasRealClerkPublishableKey()).
 *
 * NOTE (honesty): this spec was written but NOT executed in this session —
 * VITE_CLERK_PUBLISHABLE_KEY / E2E_BASE_URL are unset here, so
 * hasRealClerkPublishableKey() is false and every test below self-skips.
 * The 320px verification actually performed in this session is the jsdom
 * class-contract test (InvoicePaymentPage.layout.test.tsx) plus the
 * explicit grid-track-budget arithmetic in that same file — see the report.
 */

const hasClerk = hasRealClerkPublishableKey();

const invoiceView = {
  id: 'inv-e2e-1',
  invoiceNumber: 'INV-9001',
  status: 'open',
  customerName: 'Jordan Customer',
  businessName: 'Acme HVAC',
  businessPhone: '+15555550199',
  lineItems: [
    // 'per gal' is the longest value in catalogUnitSchema — the worst case
    // for the fixed 40px Qty track.
    { description: 'Sealant', quantity: 12, unit: 'per gal', unitPriceCents: 4_200, totalCents: 50_400 },
    { description: 'Prep labor', quantity: 3, unitPriceCents: 8_500, totalCents: 25_500 },
  ],
  totalCents: 75_900,
  subtotalCents: 75_900,
  taxCents: 0,
  discountCents: 0,
  amountPaidCents: 0,
  amountDueCents: 75_900,
  isPaid: false,
  viewCount: 1,
};

async function mockInvoiceApi(page: Page): Promise<void> {
  await page.route('**/public/invoices/**', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(invoiceView) });
      return;
    }
    // /view beacon + any other POSTs — acknowledge and move on.
    await route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/public-payments/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clientSecret: 'pi_e2e_stub_secret_abc' }),
    });
  });
}

async function openPage(page: Page): Promise<void> {
  await mockInvoiceApi(page);
  await page.goto('/pay/e2e-test-token');
  await expect(page.getByText('INV-9001')).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('invoice payment page — mobile layout / B7.5 descriptive unit', () => {
  test.skip(
    !hasClerk,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI E2E tests',
  );

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('units render without introducing horizontal overflow', async ({ page }) => {
      await openPage(page);
      await expect(page.getByTestId('line-item-unit-0')).toHaveText('per gal');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('the unit cell stays inside the 320px viewport', async ({ page }) => {
      await openPage(page);
      const unit = page.getByTestId('line-item-unit-0');
      await expect(unit).toBeVisible();
      const box = await unit.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    });

    test('the description keeps its width — the unit steals none of it', async ({ page }) => {
      await openPage(page);
      const desc = page.getByText('Sealant');
      await expect(desc).toBeVisible();
      const box = await desc.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);

      // The unit box must fit within the 40px Qty track — proof it wrapped
      // rather than pushing the row wider.
      const unitBox = await page.getByTestId('line-item-unit-0').boundingBox();
      expect(unitBox).not.toBeNull();
      expect(unitBox!.width).toBeLessThanOrEqual(40);
    });

    test('the money column is unchanged by the unit', async ({ page }) => {
      await openPage(page);
      const total = page.getByText('$504.00').first();
      await expect(total).toBeVisible();
      const box = await total.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    });
  });

  test.describe('390px (typical phone)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('no horizontal overflow', async ({ page }) => {
      await openPage(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test.describe('legacy invoice with no units at 320px', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('renders exactly as before (no unit nodes, no overflow)', async ({ page }) => {
      await page.route('**/public/invoices/**', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ...invoiceView,
              lineItems: [
                { description: 'AC Repair', quantity: 1, unitPriceCents: 42_500, totalCents: 42_500 },
              ],
            }),
          });
          return;
        }
        await route.fulfill({ status: 204, body: '' });
      });
      await page.route('**/api/public-payments/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ clientSecret: 'pi_e2e_stub_secret_abc' }),
        });
      });
      await page.goto('/pay/e2e-test-token');
      await expect(page.getByText('AC Repair')).toBeVisible();
      await expect(page.getByTestId('line-item-unit-0')).toHaveCount(0);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
