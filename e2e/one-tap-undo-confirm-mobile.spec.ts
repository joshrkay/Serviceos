import { test, expect, type Page } from '@playwright/test';
import { undoConfirmPage } from '../packages/api/src/routes/one-tap-undo-pages';

/**
 * D-015 — the owner's one-tap UNDO confirm page (GET on the undo link), a
 * public page the API renders itself. Measures what supertest can't:
 *   - no horizontal overflow at 320px, even with a long unbroken customer name
 *   - the "Undo booking" button is a ≥44px tap target
 *
 * The page is self-contained HTML (no app bundle, no backend), so the spec
 * renders the exact markup the route serves with page.setContent: no Clerk
 * key, dev-auth stack or seeded data needed. The route's own behaviour
 * (POST-only action, escaping, statuses) is pinned in
 * packages/api/test/routes/one-tap-undo.route.test.ts.
 */

// No spaces or hyphens: nothing for the browser to break on but overflow-wrap.
const LONG_NAME = 'BartholomewFeatherstonehaughWorthingtonSmytheCholmondeley';

async function openPage(page: Page): Promise<void> {
  await page.setContent(
    undoConfirmPage(
      `${LONG_NAME} — Tuesday, November 18 at 2:00 PM`,
      'e2e.token',
      '/public/proposals/one-tap-undo',
    ),
  );
  await expect(page.getByRole('heading', { name: 'Undo this booking?' })).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('one-tap UNDO confirm page — mobile layout', () => {
  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('no horizontal overflow with a long customer name', async ({ page }) => {
      await openPage(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('glove target: the Undo booking button is ≥44px tall', async ({ page }) => {
      await openPage(page);
      const button = page.getByRole('button', { name: 'Undo booking' });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });
  });
});
