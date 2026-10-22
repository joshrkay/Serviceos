import { Page } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1736 — Settings → Call review card at 320px: nothing scrolls sideways, and
 * the opt-in switch, the "Correct this call" button, the kind select and the
 * form buttons are all >=44px targets inside the viewport, even with a long
 * unbroken excerpt.
 *
 * The jsdom class contract lives in
 * packages/web/src/components/settings/CallReviewCard.test.tsx; this measures
 * the rendered layout. Every /api/voice/scoring* call is answered by
 * page.route, so the run never changes the shared dev tenant.
 *
 * Auth-gated: runs under the chromium-devauth project or an authenticated
 * E2E_BASE_URL, and skips otherwise.
 */

const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LONG = 'Caller: can you come Thursday morning to look at the TanklessWaterHeaterModelRTGH95DVLN2SerialAB0123456789XYZ unit?';

async function mockScoringApi(page: Page): Promise<{ corrected: () => unknown }> {
  let corrected: unknown = null;
  await page.route(
    (url) => url.pathname.startsWith('/api/voice/scoring'),
    async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
      const json = (status: number, body: unknown) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (route.request().method() === 'POST' && path.endsWith('/correct')) {
        corrected = route.request().postDataJSON();
        await json(201, { correction: { kind: 'should_have_booked' } });
        return;
      }
      await json(200, {
        enabled: true,
        calls: [
          {
            sessionId: SESSION,
            score: 30,
            callEndedAt: '2026-10-21T16:00:00.000Z',
            summary: 'Caller wanted Thursday morning; no slot was offered before the call ended.',
            needsReview: true,
            items: [{ id: 'booked', verdict: 'fail', rationale: 'No slot offered' }],
            flags: [{ kind: 'missed_opportunity', turnIndex: 0, excerpt: LONG, note: 'No slot offered' }],
            correction: null,
          },
        ],
      });
    },
  );
  return { corrected: () => corrected };
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('Settings → Call review — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the call review E2E test (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('the card, its switch and "Correct this call" are >=44px targets inside 320px with no sideways scroll', async ({
      page,
    }) => {
      await mockScoringApi(page);
      await page.goto('/settings');
      if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
      await dismissWhatsNewModal(page);

      await expect(page.getByTestId('call-review-card')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('call-review-flag')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      for (const target of [
        page.getByRole('switch', { name: /call scoring/i }),
        page.getByRole('button', { name: /showing calls to review/i }),
        page.getByRole('button', { name: /correct this call/i }),
      ]) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
    });

    test('the correction form fits, its controls clear 44px, and sending posts the correction', async ({ page }) => {
      const api = await mockScoringApi(page);
      await page.goto('/settings');
      if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
      await dismissWhatsNewModal(page);

      await page.getByRole('button', { name: /correct this call/i }).click();
      await expect(page.getByTestId('correction-form')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      for (const target of [
        page.getByLabel(/what should have happened/i),
        page.getByRole('button', { name: /send correction/i }),
        page.getByRole('button', { name: 'Cancel' }),
      ]) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }

      await page.getByRole('button', { name: /send correction/i }).click();
      await expect.poll(() => api.corrected()).toMatchObject({ kind: 'should_have_booked' });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
