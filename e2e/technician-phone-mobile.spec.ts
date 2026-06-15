import { test, expect, Page } from '@playwright/test';
import { setupClerkTestingToken, hasClerkTestingCreds } from './helpers/clerk-testing';
import {
  createOnboardingMockState,
  installOnboardingV2ApiMocks,
  signUpAndReachOnboarding,
} from './helpers/onboarding-v2-mock';

/**
 * Mobile/glove hardening for the technician On-call phone sheet
 * (TechnicianPhoneSheet). Measures what the jsdom class-contract test can't
 * (see TechnicianPhoneSheet.test.tsx for the class contract):
 *   - no horizontal overflow at 320px
 *   - ≥44px tap targets for the number input and the Save CTA (min-h-11)
 *
 * Reaches the sheet by signing up (Clerk testing token) with onboarding
 * mocked as progressed, then opening Settings → On-call phone. The phone
 * GET/PUT are mocked. Gated on Clerk testing creds + the v2 flag, exactly
 * like the sibling mobile specs, so it skips cleanly when the UI E2E
 * environment isn't configured.
 */

async function installPhoneApiMocks(page: Page): Promise<void> {
  await page.route('**/api/users/*/phone', async (route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'PUT') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ mobileNumber: '+15125550199' }),
      });
      return;
    }
    await route.continue();
  });
}

async function reachOnCallPhoneSheet(page: Page, emailPart: string): Promise<void> {
  await setupClerkTestingToken(page);
  const state = createOnboardingMockState();
  state.identityDone = true;
  state.packId = 'hvac';
  await installOnboardingV2ApiMocks(page, state);
  await installPhoneApiMocks(page);
  await signUpAndReachOnboarding(page, emailPart);
  await page.goto('/settings');
  await page.getByText('On-call phone').click();
  await expect(page.getByRole('heading', { name: /your phone number/i })).toBeVisible({
    timeout: 20_000,
  });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('technician on-call phone sheet — mobile layout', () => {
  test.skip(!hasClerkTestingCreds(), 'Clerk testing-token creds not set. See e2e/helpers/clerk-testing.ts.');
  test.skip(
    process.env.VITE_ONBOARDING_V2_ENABLED !== 'true',
    'VITE_ONBOARDING_V2_ENABLED=true required to render the v2 onboarding shell.',
  );

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('no horizontal overflow and glove-friendly controls', async ({ page }) => {
      await reachOnCallPhoneSheet(page, 'oncall-phone-320');

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      const input = page.getByLabel(/your cell phone/i);
      await expect(input).toBeVisible();
      expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      const save = page.getByRole('button', { name: /^save$/i });
      await expect(save).toBeVisible();
      expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    });
  });
});
