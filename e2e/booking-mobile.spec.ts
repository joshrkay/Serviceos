import { test, expect, Page } from '@playwright/test';
import { hasRealClerk } from './helpers/clerk-env';

/**
 * Mobile/glove hardening for the public online-booking page (/book?t=<uuid>).
 *
 * Measures what jsdom can't (see BookingPage.layout.test.tsx for the CSS
 * class contract):
 *   - no horizontal overflow at 320px / 390px (the 3-up slot grid + form)
 *   - ≥44px tap targets for the slot buttons, the submit CTA, the detail
 *     inputs, and the "back to times" link (glove-friendly, min-h-11)
 *   - desktop (1280px) regression: the slot picker still renders cleanly
 *
 * The page is public (token-less, tenant in the ?t= query param) and these
 * are pure layout assertions, so the API is mocked via page.route — no DB or
 * Clerk journey secrets are needed beyond the UI bundle booting.
 */

// Gate on a REAL Clerk instance (or deployed base). The offline placeholder
// key used by CI to boot the app for the offline suite must NOT un-skip this
// spec, whose behavior against a placeholder-Clerk boot is untested — keeping
// its current CI-skip behavior unchanged. (helpers/clerk-env.ts.)
const hasClerk = hasRealClerk();

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

// Fixed far-future slots → deterministic day/time rendering under UTC, and
// enough of them to fill the 3-up grid that drives horizontal overflow.
const SLOTS = [
  { start: '2099-06-01T15:00:00.000Z', end: '2099-06-01T16:00:00.000Z' },
  { start: '2099-06-01T16:30:00.000Z', end: '2099-06-01T17:30:00.000Z' },
  { start: '2099-06-01T18:00:00.000Z', end: '2099-06-01T19:00:00.000Z' },
  { start: '2099-06-02T15:00:00.000Z', end: '2099-06-02T16:00:00.000Z' },
];

async function mockBookingApi(page: Page): Promise<void> {
  // Branding (business name/phone/hours) — best-effort on the page.
  await page.route('**/public/intake/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        businessName: 'Rivera HVAC',
        businessPhone: '(602) 555-0100',
        serviceTypes: [],
        businessHoursSummary: 'Mon–Fri 8am–5pm',
      }),
    });
  });
  // Open slots for the picker.
  await page.route('**/api/public/booking/**/availability**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ timezone: 'UTC', durationMin: 60, slots: SLOTS }),
    });
  });
}

async function openPage(page: Page): Promise<void> {
  await mockBookingApi(page);
  await page.goto(`/book?t=${TENANT_ID}`);
  await expect(page.getByRole('heading', { name: /choose a time/i })).toBeVisible();
  await expect(page.getByTestId(`booking-slot-${SLOTS[0].start}`)).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('public booking — mobile layout', () => {
  test.skip(
    !hasClerk,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run UI E2E tests',
  );

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('no horizontal overflow on the slot picker', async ({ page }) => {
      await openPage(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('slot buttons and the submit CTA are ≥44px tall', async ({ page }) => {
      await openPage(page);
      const slot = page.getByTestId(`booking-slot-${SLOTS[0].start}`);
      const slotBox = await slot.boundingBox();
      expect(slotBox).not.toBeNull();
      expect(slotBox!.height).toBeGreaterThanOrEqual(44);

      // Selecting a slot enables the CTA; measure it once it's actionable.
      await slot.click();
      const cta = page.getByTestId('booking-cta');
      await expect(cta).toBeEnabled();
      const ctaBox = await cta.boundingBox();
      expect(ctaBox).not.toBeNull();
      expect(ctaBox!.height).toBeGreaterThanOrEqual(44);
    });

    test('details step: inputs and the back link are ≥44px tall, no overflow', async ({ page }) => {
      await openPage(page);
      await page.getByTestId(`booking-slot-${SLOTS[0].start}`).click();
      await page.getByTestId('booking-cta').click();

      const name = page.getByTestId('booking-field-name');
      await expect(name).toBeVisible();
      const nameBox = await name.boundingBox();
      expect(nameBox).not.toBeNull();
      expect(nameBox!.height).toBeGreaterThanOrEqual(44);

      const back = page.getByRole('button', { name: /back to times/i });
      const backBox = await back.boundingBox();
      expect(backBox).not.toBeNull();
      expect(backBox!.height).toBeGreaterThanOrEqual(44);

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
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

    test('renders the slot picker without overflow', async ({ page }) => {
      await openPage(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await expect(page.getByTestId(`booking-slot-${SLOTS[0].start}`)).toBeVisible();
    });
  });
});
