import { test, expect, Page } from '@playwright/test';
import { hasRealClerkPublishableKey } from './helpers/clerk-key';

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
 * Clerk journey secrets are needed beyond the UI bundle booting with a
 * real Clerk publishable key (CI placeholder is not enough).
 */

// Real Clerk pk (or deployed base) — placeholder alone loads clerk-js and fails.
const hasClerk = hasRealClerkPublishableKey();

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

  test.describe('EE-4 line-item photo at 320px', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    // A 1×1 PNG data URI so the thumbnail actually paints without a network
    // fetch — the layout box is what we assert, not the pixels.
    const PIXEL =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    async function mockWithImage(page: Page): Promise<void> {
      await page.route('**/public/estimates/**', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              ...estimateView,
              lineItems: [
                { description: LONG_DESCRIPTION, quantity: 1, unitPriceCents: 250000, totalCents: 250000, imageUrl: PIXEL },
                ...estimateView.lineItems.slice(1),
              ],
            }),
          });
          return;
        }
        await route.fulfill({ status: 204, body: '' });
      });
    }

    test('a wide photo thumbnail renders inside the grid without overflowing', async ({ page }) => {
      await mockWithImage(page);
      await page.goto('/e/e2e-test-token');
      await expect(page.getByText('EST-9001')).toBeVisible();

      const thumb = page.getByTestId('line-item-thumb-0');
      await expect(thumb).toBeVisible();
      const box = await thumb.boundingBox();
      expect(box).not.toBeNull();
      // Fixed 40px box, fully inside the 320px viewport.
      expect(box!.width).toBeLessThanOrEqual(48);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      // The thumbnail must not introduce horizontal overflow.
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      // Regression guard: the description on the SAME line must not collapse
      // to ~0 width. Before the flex-wrap fix, the 40px thumbnail starved the
      // item track and the description rendered one character per line (0px
      // wide, absurdly tall). It should drop below the thumbnail and keep a
      // usable width. (overflow=0 and the thumbnail box alone did NOT catch
      // this — both held while the text was broken.)
      const desc = page.getByText(LONG_DESCRIPTION);
      await expect(desc).toBeVisible();
      const descBox = await desc.boundingBox();
      expect(descBox).not.toBeNull();
      expect(descBox!.width).toBeGreaterThan(30);
    });
  });

  test.describe('B7.5 descriptive unit at 320px', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    // 'per gal' is the longest value in catalogUnitSchema — the worst case
    // for the fixed Qty track. A long unit beside a long description and a
    // 5-figure total is the combination that would push the row wide.
    const unitView = {
      ...estimateView,
      lineItems: [
        { description: LONG_DESCRIPTION, quantity: 12, unit: 'per gal', unitPriceCents: 1_234_567, totalCents: 1_234_567 },
        { description: 'Deck staining', quantity: 240, unit: 'sq ft', unitPriceCents: 375, totalCents: 90_000 },
        { description: 'Prep labor', quantity: 3, unitPriceCents: 8_500, totalCents: 25_500 },
      ],
    };

    async function openWithUnits(page: Page): Promise<void> {
      await page.route('**/public/estimates/**', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(unitView) });
          return;
        }
        await route.fulfill({ status: 204, body: '' });
      });
      await page.goto('/e/e2e-test-token');
      await expect(page.getByText('EST-9001')).toBeVisible();
    }

    test('units render without introducing horizontal overflow', async ({ page }) => {
      await openWithUnits(page);
      await expect(page.getByTestId('line-item-unit-0')).toHaveText('per gal');
      await expect(page.getByTestId('line-item-unit-1')).toHaveText('sq ft');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('the unit cell stays inside the 320px viewport', async ({ page }) => {
      await openWithUnits(page);
      const unit = page.getByTestId('line-item-unit-0');
      await expect(unit).toBeVisible();
      const box = await unit.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    });

    test('the description keeps its full width — the unit steals none of it', async ({ page }) => {
      // The mobile Qty track is deliberately left at 2rem: at 320px the grid
      // has 238px of tracks, so 2rem leaves the description 46px while 3rem
      // would leave exactly 30px. The unit wraps INSIDE the 2rem track (block
      // + break-words), adding height, not width. This pins that it did not
      // starve the description the way the EE-4 thumbnail once did.
      await openWithUnits(page);
      const desc = page.getByText(LONG_DESCRIPTION);
      await expect(desc).toBeVisible();
      const box = await desc.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(30);

      // The unit box must fit within the 2rem (32px) Qty track — proof it
      // wrapped rather than pushing the row wider.
      const unitBox = await page.getByTestId('line-item-unit-0').boundingBox();
      expect(unitBox).not.toBeNull();
      expect(unitBox!.width).toBeLessThanOrEqual(32);
    });

    test('the money column is unchanged by the unit', async ({ page }) => {
      await openWithUnits(page);
      const total = page.getByText('$12,345.67').first();
      await expect(total).toBeVisible();
      const box = await total.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
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
