import { Page } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * Mobile/glove hardening for the unified communication inbox (/comms-inbox, U5).
 *
 * Measures what jsdom can't (the CSS class contract is pinned in
 * CommsInboxPage.test.tsx):
 *   - no horizontal overflow at 320px / 390px (grid minmax(0,…) tracks +
 *     truncating previews)
 *   - ≥44px tap targets for the thread rows and the mobile "Back" control
 *
 * Unlike the public estimate page, the inbox lives behind auth, so this only
 * runs against an authenticated E2E_BASE_URL, or the chromium-devauth
 * project (e2e/helpers/dev-auth.ts, D-2), which boots the whole authenticated
 * SPA with no Clerk cloud; without either it skips (the jsdom test still
 * guards the layout contract on every run). The conversations API is mocked
 * via page.route so the assertions are pure layout.
 */

const THREADS = {
  threads: [
    {
      conversation: {
        id: 'conv-1',
        title: 'Dana Diaz',
        entityType: 'customer',
        entityId: 'cust-1',
        status: 'open',
        createdAt: '2026-06-17T10:00:00Z',
        updatedAt: '2026-06-17T10:05:00Z',
      },
      lastMessageAt: '2026-06-17T10:05:00Z',
      lastMessagePreview:
        'ReallyLongUnbrokenPreviewTokenThatCouldForceHorizontalOverflowIfTheRowDidNotTruncateXYZ0123456789',
      lastMessageDirection: 'inbound',
      needsReply: true,
      messageCount: 2,
      customerName: 'Dana Diaz',
    },
  ],
};

const MESSAGES = [
  {
    id: 'm1',
    tenantId: 't1',
    conversationId: 'conv-1',
    messageType: 'text',
    content: 'ReallyLongUnbrokenMessageTokenWithoutSpacesThatMustWrapInsteadOfOverflowingABCDEFG0123456789',
    senderId: '+15555550000',
    senderRole: 'customer',
    createdAt: '2026-06-17T10:05:00Z',
  },
];

// Anchored to the URL path (not a bare "contains" glob): under a real,
// unbundled vite dev server (chromium-devauth — D-2) the app's OWN source
// module is served at `/src/api/conversations.ts`, which a `**/api/conversations**`
// glob also matches (it contains the substring "api/conversations"),
// intercepting the module script itself and returning JSON in its place —
// a blank white page (module graph fails to load). Matching on `pathname`
// instead only catches the real `/api/conversations...` network calls.
const CONVERSATIONS_API_PATH = /^\/api\/conversations(\/|\?|$)/;

async function mockConversationsApi(page: Page): Promise<void> {
  await page.route(
    (url) => CONVERSATIONS_API_PATH.test(url.pathname),
    async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      if (url.includes('/messages')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MESSAGES) });
        return;
      }
      if (url.includes('/reply') || url.includes('/suggest-reply')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ draft: 'ok' }) });
        return;
      }
      if (method === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(THREADS) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    },
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function openInbox(page: Page): Promise<void> {
  await mockConversationsApi(page);
  await page.goto('/comms-inbox');
  await dismissWhatsNewModal(page);
  await expect(page.getByText('Dana Diaz')).toBeVisible();
}

test.describe('comms inbox — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the comms-inbox UI E2E test (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('no horizontal overflow with a long unbroken preview', async ({ page }) => {
      await openInbox(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('thread rows are ≥44px tall (glove tap target)', async ({ page }) => {
      await openInbox(page);
      const row = page.getByTestId('comms-thread-row').first();
      await expect(row).toBeVisible();
      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });

    test('opening a thread keeps the layout inside the viewport and the Back control is ≥44px', async ({ page }) => {
      await openInbox(page);
      await page.getByTestId('comms-thread-row').first().click();
      const back = page.getByTestId('comms-thread-back');
      await expect(back).toBeVisible();
      const box = await back.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test.describe('390px (typical phone)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('no horizontal overflow', async ({ page }) => {
      await openInbox(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
