import { Page } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1389 / O-2 — the owner's reviewed E1 script form (/settings/e1-script) at
 * 320px: every control is a ≥44px target, nothing scrolls sideways, and the
 * placeholder banner's link lands on the form.
 *
 * The jsdom class contract lives in
 * packages/web/src/components/settings/E1ScriptSettingsPage.test.tsx; this
 * measures the rendered layout. The PUT is answered by page.route so the
 * run never changes the shared dev tenant's live E1 script (the GET is real).
 *
 * Auth-gated: runs under the chromium-devauth project or an authenticated
 * E2E_BASE_URL, and skips otherwise.
 */

async function openForm(page: Page): Promise<void> {
  await page.goto('/settings/e1-script');
  await dismissWhatsNewModal(page);
  // Generous: the lazy route chunk compiles on first hit under the dev server.
  await expect(page.getByTestId('e1-script-settings')).toBeVisible({ timeout: 20_000 });
}

const CONTROLS = [
  'Emergency script',
  'Trade professional name',
  'Trade professional license',
  'Trade professional review date',
  'Counsel name',
  'Counsel bar number',
  'Counsel review date',
];

test.describe('E1 script form — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the E1 script form E2E test (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('the placeholder banner links to the form', async ({ page }) => {
      await page.goto('/');
      await dismissWhatsNewModal(page);
      await page.getByRole('link', { name: 'Add reviewed script' }).click();
      await expect(page).toHaveURL(/\/settings\/e1-script$/);
      await expect(page.getByTestId('e1-script-settings')).toBeVisible();
    });

    test('every field, the confirmation row and Save are ≥44px and inside the viewport', async ({ page }) => {
      await openForm(page);
      const targets = [
        ...CONTROLS.map((label) => page.getByLabel(label, { exact: true })),
        page.getByText('I confirm both reviewers signed off on exactly this script.'),
        page.getByRole('button', { name: 'Save reviewed script' }),
      ];
      for (const target of targets) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
      for (const label of CONTROLS) {
        const box = await page.getByLabel(label, { exact: true }).boundingBox();
        expect(Math.round(box!.height), label).toBeGreaterThanOrEqual(44);
      }
      const confirmRow = page.getByRole('checkbox', { name: /both reviewers signed off/i }).locator('xpath=ancestor::label[1]');
      expect(Math.round((await confirmRow.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
      const save = await page.getByRole('button', { name: 'Save reviewed script' }).boundingBox();
      expect(Math.round(save!.height)).toBeGreaterThanOrEqual(44);
    });

    test('a filled form saves both sign-offs without the page scrolling sideways', async ({ page }) => {
      let putBody: { script?: string; reviewers?: Array<{ kind: string }> } | null = null;
      await page.route(
        (url) => url.pathname === '/api/settings/e1-script',
        async (route) => {
          if (route.request().method() !== 'PUT') {
            await route.fallback();
            return;
          }
          putBody = route.request().postDataJSON();
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              status: 'reviewed',
              reviewedScript: putBody?.script ?? '',
              reviewedByName: null,
              reviewedByRole: null,
              reviewedAt: null,
              reviewers: putBody?.reviewers ?? [],
              missingReviewerKinds: [],
            }),
          });
        },
      );
      await openForm(page);
      await page.getByLabel('Emergency script', { exact: true }).fill(
        'If anyone is in danger, hang up and dial 911 now. Get everyone out of the house and wait outside.',
      );
      await page.getByLabel('Trade professional name', { exact: true }).fill('Pat Reviewer');
      await page.getByLabel('Trade professional license', { exact: true }).fill('Master Plumber M-00000 (TX)');
      await page.getByLabel('Trade professional review date', { exact: true }).fill('2026-09-20');
      await page.getByLabel('Counsel name', { exact: true }).fill('Robin Counsel');
      await page.getByLabel('Counsel bar number', { exact: true }).fill('State Bar 00000000 (TX)');
      await page.getByLabel('Counsel review date', { exact: true }).fill('2026-09-21');
      await page.getByRole('checkbox', { name: /both reviewers signed off/i }).check();
      await page.getByRole('button', { name: 'Save reviewed script' }).click();

      await expect(page.getByText('Your reviewed script is live on emergency calls.')).toBeVisible();
      expect(putBody!.reviewers!.map((r) => r.kind)).toEqual(['trade_professional', 'counsel']);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
