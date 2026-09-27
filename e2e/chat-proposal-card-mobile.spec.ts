import { Page } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1276 leftover — mobile/glove hardening for the chat proposal card
 * (/assistant, AIProposalCard inline in the thread).
 *
 * Measures what jsdom can't (the CSS class contract is pinned in
 * AIProposalCard.tap-targets.test.tsx):
 *   - the card's Approve / Edit / Dismiss buttons are ≥44px tall at 320px
 *   - no horizontal overflow at 320px with a long unbroken token in the card
 *
 * /assistant lives behind auth, so this only runs against an authenticated
 * E2E_BASE_URL or the chromium-devauth project (e2e/helpers/dev-auth.ts);
 * without either it skips. The chat API is mocked via page.route so the
 * assertions are pure layout: one typed turn gets a mocked reply and the
 * reply carries the proposal card.
 */

const LONG_TOKEN = 'TanklessWaterHeaterModelRTGH95DVLN2SerialAB0123456789XYZ';

const CHAT_REPLY = {
  taskType: 'assistant.task',
  model: 'mock',
  usage: { input: 0, output: 0, total: 0 },
  message: {
    role: 'assistant',
    content: 'Drafted an estimate. Review and approve when ready.',
    proposal: {
      id: 'prop-chat-e2e',
      title: `Estimate: ${LONG_TOKEN} for Priya Whitfield`,
      summary: `Replace ${LONG_TOKEN} with recirculation pump.`,
      explanation: 'Drafted from chat.',
      confidence: 'High',
      type: 'Estimate',
      status: 'Pending',
      proposalType: 'draft_estimate',
      editFields: [{ label: 'Notes', key: 'notes', value: '' }],
    },
  },
};

async function mockChatApi(page: Page): Promise<void> {
  // Anchored on the pathname so vite's own /src/api/… module URLs never match.
  await page.route((url) => url.pathname === '/api/assistant/chat', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CHAT_REPLY) });
  });
}

async function openCard(page: Page): Promise<void> {
  await mockChatApi(page);
  await page.goto('/assistant');
  await dismissWhatsNewModal(page);
  const input = page.getByPlaceholder('Ask anything or give a command…');
  await input.fill('Draft an estimate for Priya');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('chat proposal card — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      !!process.env.E2E_BASE_URL,
      'Set E2E_BASE_URL (authenticated) to run the assistant UI E2E test (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('glove targets: Approve, Edit and Dismiss are ≥44px tall', async ({ page }) => {
      await openCard(page);
      for (const name of ['Approve', 'Edit', 'Dismiss']) {
        const button = page.getByRole('button', { name, exact: true });
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        // Rounded: the thread lays out at sub-pixel offsets, so a min-h-11
        // button measures 43.9999…px. Before min-h-11 these were 32px.
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
    });

    test('no horizontal overflow with a long unbroken token on the card', async ({ page }) => {
      await openCard(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      // The card clips its own overflow, so the page never scrolls; the
      // token has to wrap inside its line instead of running under the edge.
      const title = page.getByText(CHAT_REPLY.message.proposal.title, { exact: true });
      const clipped = await title.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(clipped).toBeLessThanOrEqual(0);
    });
  });
});
