import { test, expect, Page } from '@playwright/test';
import { setupClerkTestingToken, hasClerkTestingCreds } from './helpers/clerk-testing';
import {
  createOnboardingMockState,
  installOnboardingV2ApiMocks,
  signUpAndReachOnboarding,
  createOnboardingConversationMockState,
  installOnboardingConversationApiMocks,
  ONBOARDING_CONVERSATION_OPENING_PROMPT,
  ONBOARDING_CONVERSATION_USER_MESSAGES,
} from './helpers/onboarding-v2-mock';

/**
 * B1.19 AC-7 — mobile/glove hardening for the "talk it through" step.
 *
 * Measures what jsdom can't (see ConversationStep.layout.test.tsx for the
 * CSS class contract this pins the real-layout half of):
 *   - no horizontal overflow at 320px with long transcript text
 *   - ≥44px tap targets for the mic toggle, send button, and the
 *     "switch back to form" link
 *
 * /onboarding is behind Clerk auth (unlike the public estimate-approval
 * page this pattern is modeled on), so this needs real Clerk
 * testing-token creds, same gate as the other onboarding-v2 journeys.
 */

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('conversational onboarding — mobile layout', () => {
  test.skip(
    !hasClerkTestingCreds(),
    'Clerk testing-token creds not set. See e2e/helpers/clerk-testing.ts.',
  );
  test.skip(
    process.env.VITE_ONBOARDING_V2_ENABLED !== 'true',
    'VITE_ONBOARDING_V2_ENABLED=true required.',
  );

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('no horizontal overflow with a long transcript bubble', async ({ page }) => {
      await setupClerkTestingToken(page);
      await installOnboardingV2ApiMocks(page, createOnboardingMockState());
      await installOnboardingConversationApiMocks(page, createOnboardingConversationMockState());

      await signUpAndReachOnboarding(page, 'v2conv-mobile-overflow');
      await page.getByRole('button', { name: /talk it through instead/i }).click();
      await expect(page.getByText(ONBOARDING_CONVERSATION_OPENING_PROMPT)).toBeVisible();

      // A long, unbroken utterance — the same overflow trigger the
      // estimate-approval mobile spec uses for line-item descriptions.
      const longMessage = ONBOARDING_CONVERSATION_USER_MESSAGES[0].repeat(3);
      await page.getByLabel('Your answer').fill(longMessage);
      await page.getByRole('button', { name: /^send$/i }).click();
      await expect(page.getByText(longMessage)).toBeVisible();

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('glove targets: mic toggle, send, and "switch back" are ≥44px tall', async ({ page }) => {
      await setupClerkTestingToken(page);
      await installOnboardingV2ApiMocks(page, createOnboardingMockState());
      await installOnboardingConversationApiMocks(page, createOnboardingConversationMockState());

      await signUpAndReachOnboarding(page, 'v2conv-mobile-targets');

      // Mobile hides the full Sidebar (md:hidden); the compact mic icon
      // toggle in MobileProgress is the entry point at this breakpoint —
      // and its aria-label is worded distinctly from the Sidebar's so this
      // selector is unambiguous even though both exist in the DOM.
      await page.getByLabel(/talk it through \(mic\)/i).click();
      await expect(page.getByText(ONBOARDING_CONVERSATION_OPENING_PROMPT)).toBeVisible();

      for (const locator of [
        page.getByRole('button', { name: /start talking/i }),
        page.getByRole('button', { name: /prefer the form/i }),
      ]) {
        await expect(locator).toBeVisible();
        const box = await locator.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }

      await page.getByLabel('Your answer').fill(ONBOARDING_CONVERSATION_USER_MESSAGES[0]);
      const sendBtn = page.getByRole('button', { name: /^send$/i });
      const sendBox = await sendBtn.boundingBox();
      expect(sendBox).not.toBeNull();
      expect(sendBox!.height).toBeGreaterThanOrEqual(44);

      const input = page.getByLabel('Your answer');
      const inputBox = await input.boundingBox();
      expect(inputBox).not.toBeNull();
      expect(inputBox!.height).toBeGreaterThanOrEqual(44);
    });
  });

  test.describe('390px (typical phone) regression', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('no horizontal overflow', async ({ page }) => {
      await setupClerkTestingToken(page);
      await installOnboardingV2ApiMocks(page, createOnboardingMockState());
      await installOnboardingConversationApiMocks(page, createOnboardingConversationMockState());

      await signUpAndReachOnboarding(page, 'v2conv-mobile-390');
      await page.getByRole('button', { name: /talk it through instead/i }).click();
      await expect(page.getByText(ONBOARDING_CONVERSATION_OPENING_PROMPT)).toBeVisible();

      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
