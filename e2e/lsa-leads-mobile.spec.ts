import { Page } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1738 — Settings → Google Local Services leads sheet at 320px: nothing
 * scrolls sideways (long webhook URL and secret wrap), and every control is a
 * ≥44px target inside the viewport.
 *
 * The jsdom class contract lives in
 * packages/web/src/components/settings/LsaLeadsSheet.test.tsx; this measures
 * the rendered layout. Every /api/lsa-integration call is answered by
 * page.route. Auth-gated: chromium-devauth or an authenticated E2E_BASE_URL.
 */

const LINKED = {
  enabled: true,
  autoRespond: false,
  secretHint: 'ab12',
  accountId: null,
  webhookUrl:
    'https://api.example.com/webhooks/lsa/00000000-0000-4000-8000-000000000000?relay=very-long-relay-name-for-wrapping',
  recentLeads: [
    {
      leadId: 'l1',
      name: 'Alexandria Montgomery-Featherstonehaugh',
      stage: 'new',
      leadType: 'message',
      receivedAt: '2026-10-22T10:00:00Z',
      speedToLead: null,
      disposition: null,
    },
  ],
};

async function mockLsaApi(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/lsa-integration'),
    async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
      const json = (body: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/lsa-integration/link') {
        await json({ data: { ...LINKED, webhookSecret: `lsa_${'f'.repeat(48)}` } });
        return;
      }
      await json({ data: LINKED });
    },
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('Settings → Google Local Services leads — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the LSA leads E2E test (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('controls are glove targets inside 320px and long values do not overflow', async ({ page }) => {
      await mockLsaApi(page);
      await page.goto('/settings');
      await dismissWhatsNewModal(page);
      await page.getByText('Google Local Services leads', { exact: true }).first().click();
      await expect(page.getByTestId('lsa-linked')).toBeVisible({ timeout: 20_000 });

      await page.getByTestId('lsa-rotate').click();
      await expect(page.getByTestId('lsa-new-secret')).toBeVisible();

      const targets = [
        page.getByTestId('lsa-rotate'),
        page.getByTestId('lsa-unlink'),
        page.getByTestId('lsa-auto-respond').locator('xpath=ancestor::label'),
        page.getByRole('button', { name: 'Close' }),
      ];
      for (const target of targets) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
