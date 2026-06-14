import { test, expect, Page } from '@playwright/test';
import { setupClerkTestingToken, hasClerkTestingCreds } from './helpers/clerk-testing';
import {
  createOnboardingMockState,
  installOnboardingV2ApiMocks,
  signUpAndReachOnboarding,
} from './helpers/onboarding-v2-mock';

/**
 * Mobile/glove hardening for the onboarding phone-number picker (PhoneStep).
 *
 * Measures what the jsdom class-contract test can't
 * (see PhoneStep.test.tsx for the class contract):
 *   - no horizontal overflow at 320px / 390px
 *   - ≥44px tap targets for the area-code input, Search, each candidate row,
 *     and the Claim CTA (glove-friendly, min-h-11)
 *
 * Reaches the phone step by mocking onboarding status with identity + pack
 * already done (so `phone` is the current step), then mocks the picker's
 * /available + /claim endpoints. Gated on Clerk testing creds + the v2 flag,
 * exactly like e2e/journeys/onboarding-v2.spec.ts, so it skips cleanly when
 * the UI E2E environment isn't configured.
 */

const CANDIDATES = [
  { phoneNumber: '+15125550001', locality: 'Austin', region: 'TX' },
  { phoneNumber: '+15125550002', locality: 'Austin', region: 'TX' },
  { phoneNumber: '+15125550003', locality: 'Round Rock', region: 'TX' },
];

async function installPhonePickerMocks(page: Page): Promise<void> {
  await page.route('**/api/onboarding/phone/available', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ numbers: CANDIDATES }),
    });
  });
  await page.route('**/api/onboarding/phone/claim', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, enqueued: true }),
    });
  });
}

async function reachPicker(page: Page, emailPart: string): Promise<void> {
  await setupClerkTestingToken(page);
  const state = createOnboardingMockState();
  state.identityDone = true;
  state.packId = 'hvac';
  await installOnboardingV2ApiMocks(page, state);
  await installPhonePickerMocks(page);
  await signUpAndReachOnboarding(page, emailPart);
  await expect(page.getByRole('heading', { name: /pick your own number/i })).toBeVisible({
    timeout: 20_000,
  });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function expectTallEnough(page: Page, role: 'button' | 'textbox', name: RegExp): Promise<void> {
  const locator = page.getByRole(role, { name });
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

test.describe('onboarding phone picker — mobile layout', () => {
  test.skip(!hasClerkTestingCreds(), 'Clerk testing-token creds not set. See e2e/helpers/clerk-testing.ts.');
  test.skip(
    process.env.VITE_ONBOARDING_V2_ENABLED !== 'true',
    'VITE_ONBOARDING_V2_ENABLED=true required to render the v2 onboarding shell.',
  );

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('no horizontal overflow and glove-friendly search controls', async ({ page }) => {
      await reachPicker(page, 'picker-320');

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await expectTallEnough(page, 'textbox', /area code/i);
      await expectTallEnough(page, 'button', /^search$/i);
    });

    test('candidate rows and the claim CTA are ≥44px tall, no overflow', async ({ page }) => {
      await reachPicker(page, 'picker-320-claim');

      await page.getByLabel(/area code/i).fill('512');
      await page.getByRole('button', { name: /^search$/i }).click();

      const row = page.getByRole('button', { name: /\(512\) 555-0001/ });
      await expect(row).toBeVisible();
      const rowBox = await row.boundingBox();
      expect(rowBox!.height).toBeGreaterThanOrEqual(44);

      await row.click();
      await expectTallEnough(page, 'button', /claim/i);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test.describe('390px (typical phone)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('no horizontal overflow with candidates listed', async ({ page }) => {
      await reachPicker(page, 'picker-390');
      await page.getByLabel(/area code/i).fill('512');
      await page.getByRole('button', { name: /^search$/i }).click();
      await expect(page.getByRole('button', { name: /\(512\) 555-0001/ })).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
