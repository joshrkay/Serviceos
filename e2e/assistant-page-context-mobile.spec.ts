import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * The "About the job you were viewing" chip a VoiceBar hand-off attaches to
 * the assistant composer, at 320px. The class contract (≥44px remove button)
 * is pinned in AssistantPage.test.tsx; this measures the real layout: the chip
 * and its remove button sit inside the viewport and nothing scrolls sideways.
 *
 * /assistant lives behind auth, so this only runs against an authenticated
 * E2E_BASE_URL or the chromium-devauth project (e2e/helpers/dev-auth.ts).
 */

const JOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test.describe('/assistant page-context chip — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the assistant UI E2E test (or run under the chromium-devauth project)',
    );
  });

  test.use({ viewport: { width: 320, height: 690 } });

  test('the chip and its remove button fit, and the page does not scroll sideways', async ({ page }) => {
    await page.goto(`/assistant?ctx=job:${JOB}`);
    await dismissWhatsNewModal(page);
    const chip = page.getByTestId('assistant-page-context-chip');
    await expect(chip).toBeVisible();

    const remove = page.getByRole('button', { name: 'Remove page context' });
    const box = await remove.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);

    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(0);

    await remove.click();
    await expect(chip).toHaveCount(0);
  });
});
