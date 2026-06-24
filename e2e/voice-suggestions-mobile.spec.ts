import { test, expect, Page } from '@playwright/test';

const hasClerk = !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

async function mockShellWithVoiceBar(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test.describe('VoiceSuggestions strip — mobile layout', () => {
  test.skip(!hasClerk, 'requires Clerk publishable key or E2E_BASE_URL');

  for (const width of [320, 390] as const) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await mockShellWithVoiceBar(page);
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/schedule');

      const strip = page.getByTestId('voice-suggestions-strip');
      await expect(strip).toBeVisible({ timeout: 15_000 });

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth;
      });
      expect(overflow).toBe(false);

      const buttons = strip.locator('button');
      const count = await buttons.count();
      expect(count).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < count; i += 1) {
        const box = await buttons.nth(i).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    });
  }
});
