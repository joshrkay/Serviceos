import { test, expect, Page } from '@playwright/test';

/**
 * Mobile/glove hardening for the public estimate approval page (/e/:id).
 *
 * Measures what jsdom can't (see EstimateApprovalPage.layout.test.tsx
 * for the CSS class contract):
 *   - no horizontal overflow at 320px / 390px (the grid minmax(0,1fr) fix)
 *   - ≥44px tap targets for the show-more toggle, Download PDF, and the
 *     accept CTA (glove-friendly, min-h-11)
 *   - the big-money total column stays inside the viewport
 *   - desktop (1280px) regression: same content, sm: column widths
 *
 * The backend is mocked via page.route — the page is public
 * (view-token-gated) and these are pure layout assertions, so no DB or
 * Clerk journey secrets are needed beyond the UI bundle booting.
 */

// Same gate as smoke — ui: the app's main.tsx throws at module load
// without a Clerk publishable key (P0-026 startup guard).
const hasClerk = !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

const LONG_DESCRIPTION =
  'TanklessWaterHeaterModelRTGH95DVLN2SerialAB0123456789XYZ Replacement with recirculation pump';

const estimateView = {
  id: 'est-e2e-1',
  estimateNumber: 'EST-9001',
  status: 'sent',
  customerName: 'Sarah Johnson',
  businessName: 'Acme HVAC',
  lineItems: [
    { description: LONG_DESCRIPTION, quantity: 1, unitPriceCents: 1_234_567, totalCents: 1_234_567 },
    { description: 'AC tune-up', quantity: 1, unitPriceCents: 12_500, totalCents: 12_500 },
    { description: 'Filter swap', quantity: 2, unitPriceCents: 2_000, totalCents: 4_000 },
    { description: 'Thermostat', quantity: 1, unitPriceCents: 9_900, totalCents: 9_900 },
    { description: 'Labor', quantity: 3, unitPriceCents: 15_000, totalCents: 45_000 },
  ],
  totalCents: 1_305_967,
  subtotalCents: 1_305_967,
  taxCents: 0,
  discountCents: 0,
  isActionable: true,
  isExpired: false,
  depositRequiredCents: 0,
  depositPaidCents: 0,
  depositStatus: 'not_required',
};

async function mockEstimateApi(page: Page): Promise<void> {
  await page.route('**/public/estimates/**', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(estimateView) });
      return;
    }
    // /view beacon + any other POSTs — acknowledge and move on.
    await route.fulfill({ status: 204, body: '' });
  });
}

async function openPage(page: Page): Promise<void> {
  await mockEstimateApi(page);
  await page.goto('/e/e2e-test-token');
  await expect(page.getByText('EST-9001')).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('estimate approval — mobile layout', () => {
  test.skip(
    !hasClerk,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI E2E tests',
  );

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('no horizontal overflow with a long description and 5-figure totals', async ({ page }) => {
      await openPage(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('the big-money total cell stays inside the viewport', async ({ page }) => {
      await openPage(page);
      const total = page.getByText('$12,345.67').first();
      await expect(total).toBeVisible();
      const box = await total.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    });

    test('glove targets: toggle, Download PDF, and accept CTA are ≥44px tall', async ({ page }) => {
      await openPage(page);
      for (const locator of [
        page.getByRole('button', { name: /more items/i }),
        page.getByRole('button', { name: /download pdf/i }),
        page.getByRole('button', { name: /accept/i }).first(),
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

    test('no horizontal overflow', async ({ page }) => {
      await openPage(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test.describe('1280px (desktop regression)', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('renders all four columns and the totals row without overflow', async ({ page }) => {
      await openPage(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await expect(page.getByText('Item', { exact: true })).toBeVisible();
      await expect(page.getByText('Qty', { exact: true })).toBeVisible();
      await expect(page.getByText('Rate', { exact: true })).toBeVisible();
      await expect(page.getByText('Total', { exact: true })).toBeVisible();
      await expect(page.getByText('Estimate total')).toBeVisible();
    });
  });
});
