import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';
import { hasRealClerkPublishableKey } from './helpers/clerk-key';

/**
 * #1283 — the Shell mobile bar (CLAUDE.md): every topbar / bottom-tab control
 * is ≥44×44 and nothing overflows at 320px. The CSS class contract is pinned
 * in packages/web/src/components/layout/Shell.tap-targets.test.tsx; this spec
 * measures the real boxes in Chromium, which jsdom can't.
 *
 * Runs under the chromium-devauth project (owner session, so the mode toggle —
 * the widest topbar control — is present) or an authenticated stack; skips
 * otherwise.
 */

async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function expectTapTarget(
  locator: import('@playwright/test').Locator,
  what: string,
  viewportWidth: number,
): Promise<void> {
  await expect(locator, what).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, what).not.toBeNull();
  expect(box!.height, `${what} height`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${what} width`).toBeGreaterThanOrEqual(44);
  expect(box!.x + box!.width, `${what} inside viewport`).toBeLessThanOrEqual(viewportWidth);
}

test.describe('Shell — mobile bar', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      hasRealClerkPublishableKey() || !!process.env.E2E_BASE_URL,
      'Set a real Clerk pk / E2E_BASE_URL to run authenticated UI tests (or run under the chromium-devauth project)',
    );
  });

  for (const width of [320, 375]) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height: 720 } });

      test('topbar and bottom-tab controls are ≥44×44 with no horizontal overflow', async ({ page }) => {
        await page.goto('/jobs');
        if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
        await dismissWhatsNewModal(page);

        const topbar = page.getByTestId('mobile-topbar');
        await expect(topbar).toBeVisible();

        await expectTapTarget(page.getByTestId('mobile-inbox-bell'), 'approval bell', width);
        await expectTapTarget(page.getByTestId('mobile-account-button'), 'avatar / settings', width);
        await expectTapTarget(topbar.getByRole('button', { name: /open camera/i }), 'camera', width);

        const segments = topbar.getByRole('radio');
        const segmentCount = await segments.count();
        for (let i = 0; i < segmentCount; i++) {
          await expectTapTarget(segments.nth(i), `mode segment ${i}`, width);
        }

        const tabs = page.getByTestId('mobile-bottom-nav').locator('a, button');
        const tabCount = await tabs.count();
        expect(tabCount).toBeGreaterThan(0);
        for (let i = 0; i < tabCount; i++) {
          const box = await tabs.nth(i).boundingBox();
          expect(box?.height ?? 0, `bottom tab ${i}`).toBeGreaterThanOrEqual(44);
        }

        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      });
    });
  }
});
