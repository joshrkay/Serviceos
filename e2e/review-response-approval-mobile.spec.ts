import { test, expect, Page } from '@playwright/test';

/**
 * U6 — mobile/glove hardening for the inbox review-response approval card
 * (/inbox, review_response_proposal).
 *
 * Measures what jsdom can't (the CSS class contract is pinned in
 * InboxPage.reviewResponse.test.tsx):
 *   - no horizontal overflow at 320px / 390px with a long unbroken token in
 *     the drafted reply (whitespace-pre-wrap + break-words)
 *   - ≥44px tap targets for the component toggles and the Approve button
 *   - the draft text block stays inside the viewport
 *
 * Like the comms inbox (comms-inbox-mobile.spec.ts), /inbox lives behind
 * auth, so this only runs against an authenticated E2E_BASE_URL; without one
 * it skips (the jsdom test still guards the contract on every run). The
 * proposals API is mocked via page.route so the assertions are pure layout.
 */
const hasAuthedBase = !!process.env.E2E_BASE_URL;

const LONG_TOKEN =
  'ThanksSoMuchForTheKindWordsAboutTheTanklessWaterHeaterInstallRTGH95DVLN2WeLovedWorkingWithYou0123456789';

const DRAFT_REPLY = `Thanks for the review, Dana! ${LONG_TOKEN} — see you at the fall tune-up.`;

const INBOX_RESPONSE = {
  data: [
    {
      proposal: {
        id: 'p-rev-e2e',
        proposalType: 'review_response_proposal',
        summary: 'Respond to Dana Diaz’s 5-star review',
        status: 'ready_for_review',
        createdAt: '2026-07-30T10:00:00.000Z',
        payload: {
          reviewId: 'a0000000-0000-4000-8000-000000000009',
          classification: 'praise',
          publicResponse: { text: DRAFT_REPLY, approved: false },
          privateFollowUp: {
            customerId: 'c0000000-0000-4000-8000-000000000001',
            channel: 'sms',
            body: 'Hi Dana, thank you again — call us any time.',
            approved: false,
          },
          serviceCredit: {
            customerId: 'c0000000-0000-4000-8000-000000000001',
            amountCents: 2500,
            approved: false,
          },
        },
      },
      urgency: 'normal',
      reason: 'Awaiting review',
    },
  ],
  summary: {
    totalCount: 1,
    criticalCount: 0,
    highCount: 0,
    normalCount: 1,
    lowCount: 0,
    truncated: false,
  },
};

async function mockProposalsApi(page: Page): Promise<void> {
  // Catch-all first; later-registered (more specific) routes take precedence.
  await page.route('**/api/proposals**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/proposals/inbox**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(INBOX_RESPONSE),
    });
  });
}

async function openInbox(page: Page): Promise<void> {
  await mockProposalsApi(page);
  await page.goto('/inbox');
  await expect(page.getByTestId('review-response-review')).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('review-response approval — mobile layout', () => {
  test.skip(!hasAuthedBase, 'Set E2E_BASE_URL (authenticated) to run the inbox UI E2E test');

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 690 } });

    test('no horizontal overflow with a long unbroken token in the reply', async ({ page }) => {
      await openInbox(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('the draft text block stays inside the viewport with a usable width', async ({ page }) => {
      await openInbox(page);
      const draft = page.getByTestId('review-public-draft');
      await expect(draft).toBeVisible();
      const box = await draft.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      // Regression guard: with side-by-side Reject/Approve the content
      // column collapsed to ~92px (one word per line). The stacked action
      // column (flex-col below sm:) must leave the draft a readable track.
      expect(box!.width).toBeGreaterThan(150);
    });

    test('glove targets: component toggles and Approve are ≥44px tall', async ({ page }) => {
      await openInbox(page);
      const toggles = page.getByTestId('review-component-toggle');
      await expect(toggles).toHaveCount(3);
      for (let i = 0; i < 3; i += 1) {
        const box = await toggles.nth(i).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      for (const name of ['Approve', 'Reject']) {
        const button = page.getByRole('button', { name, exact: true });
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
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
