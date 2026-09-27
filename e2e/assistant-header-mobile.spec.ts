import { Page } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1384 — the /assistant page header at 320px. Before the fix the header row
 * (avatar + title on the left, four tool buttons on the right) was wider than
 * a 320px phone: the avatar and the Conversation pill were clipped.
 *
 * Measures what jsdom can't (the class contract is pinned in
 * AssistantPage.test.tsx): every header control sits fully inside the
 * viewport, the Conversation toggle keeps its ≥44px glove target, and
 * neither the header nor the page scrolls sideways.
 *
 * /assistant lives behind auth, so this only runs against an authenticated
 * E2E_BASE_URL or the chromium-devauth project (e2e/helpers/dev-auth.ts).
 */

async function openAssistant(page: Page): Promise<void> {
  await page.goto('/assistant');
  await dismissWhatsNewModal(page);
  await expect(page.getByTestId('assistant-header')).toBeVisible();
}

test.describe('/assistant header — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the assistant UI E2E test (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('the avatar and every header control sit fully inside the viewport', async ({ page }) => {
      await openAssistant(page);
      const header = page.getByTestId('assistant-header');
      const targets = [
        header.getByTestId('assistant-avatar'),
        header.getByRole('button', { name: /conversation/i }),
        header.getByTitle(/voice responses/i),
        header.getByTitle('Live voice session'),
      ];
      for (const target of targets) {
        await expect(target).toBeVisible();
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
    });

    test('the Conversation toggle keeps its ≥44px glove target', async ({ page }) => {
      await openAssistant(page);
      const box = await page
        .getByTestId('assistant-header')
        .getByRole('button', { name: /conversation/i })
        .boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
    });

    test('neither the header nor the page scrolls sideways', async ({ page }) => {
      await openAssistant(page);
      const headerOverflow = await page
        .getByTestId('assistant-header')
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(headerOverflow).toBeLessThanOrEqual(0);
      const pageOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(pageOverflow).toBeLessThanOrEqual(0);
    });
  });
});
