import { expect, type Page } from '@playwright/test';
import { test, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';
import { hasRealClerkPublishableKey } from './helpers/clerk-key';

/**
 * D-045 — the message status bubble (customer page), the blocked-texts
 * notice (inbox) and the dispatch log's "Not sent" list. Pins the mobile bar
 * (CLAUDE.md): no horizontal overflow at 320px, ≥44px tap targets. jsdom
 * class-contract coverage lives next to the components in
 * packages/web/src/components/interactions/*.test.tsx.
 *
 * The message records are mocked via page.route with a long block reason, so
 * the layout is measured against the worst wording the bubble can show. The
 * customer page needs a real customer, created through the dev-auth API, so
 * that test runs only under the chromium-devauth project.
 */

const DEV_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJkZXZfb3duZXIiLCJzaWQiOiJkZXYtc2Vzc2lvbiIsInJvbGUiOiJvd25lciJ9.x';

function blockedRecord(customerId: string) {
  return {
    id: 'disp-e2e-1',
    entityType: 'thank_you',
    entityId: 'job-e2e-1',
    channel: 'sms',
    recipient: '',
    provider: 'unknown',
    status: 'blocked',
    blockReason: 'recipient_volume_cap',
    blockPermanent: false,
    sentAt: '2026-10-21T18:00:00Z',
    customerId,
    jobId: 'job-e2e-1',
    purpose: 'automated_nudge',
  };
}

async function mockDispatches(page: Page, customerId: string): Promise<void> {
  await page.route('**/api/interactions/dispatches**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ dispatches: [blockedRecord(customerId)], total: 1, limit: 50, offset: 0 }),
    });
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
}

async function expectTall(page: Page, locator: ReturnType<Page['getByTestId']>): Promise<void> {
  await expect(locator).toBeVisible();
  expect((await locator.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
}

test.describe('message status — mobile viewport', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      hasRealClerkPublishableKey(),
      'Set E2E_BASE_URL or a real Clerk pk to run authenticated UI tests (or run under the chromium-devauth project)',
    );
  });
  test.use({ viewport: { width: 320, height: 720 } });

  test('the "Not sent" list fits 320px and its controls clear 44px', async ({ page }) => {
    await mockDispatches(page, 'cust-e2e-1');
    await page.goto('/interactions/dispatch?status=blocked');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

    await expect(page.getByText(/Text not sent: this number already got the most texts allowed today/)).toBeVisible();
    for (const name of ['All', 'Not sent', 'Held']) {
      const button = page.getByRole('button', { name, exact: true });
      expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    for (const name of ['Open job', 'Open customer']) {
      const link = page.getByRole('link', { name, exact: true });
      expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalOverflow(page);
  });

  test('the inbox notice counts blocked texts and fits 320px', async ({ page }) => {
    await mockDispatches(page, 'cust-e2e-1');
    await page.goto('/inbox');
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

    const notice = page.getByTestId('blocked-texts-notice');
    await expectTall(page, notice);
    await expect(notice).toContainText("1 customer text didn't go out");
    await expectNoHorizontalOverflow(page);
  });

  test('the customer page shows the latest text status and fits 320px', async ({
    page,
    request,
    devAuthActive,
  }) => {
    test.skip(!devAuthActive, 'Creates its own customer through the dev-auth API');
    const apiURL = process.env.E2E_DEVAUTH_API_URL ?? 'http://127.0.0.1:3001';
    const created = await request.post(`${apiURL}/api/customers`, {
      headers: { Authorization: `Bearer ${DEV_TOKEN}` },
      data: { firstName: 'Morgan', lastName: `Status ${Date.now()}`, preferredChannel: 'phone', smsConsent: false },
    });
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };

    await mockDispatches(page, id);
    await page.goto(`/customers/${id}`);
    if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
    await dismissWhatsNewModal(page);

    const bubble = page.getByTestId('latest-text-status');
    await bubble.scrollIntoViewIfNeeded();
    await expectTall(page, bubble);
    await expect(bubble).toHaveAttribute('href', `/interactions/dispatch?customerId=${id}`);
    await expectNoHorizontalOverflow(page);
  });
});
