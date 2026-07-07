import { offlineTest as test, expect } from '../helpers/offline-app';
import { installAssistantMocks, PROPOSAL_ID } from '../helpers/api-mocks/assistant';
import { DATA_TIMEOUT, type ApiTrackerEntry } from '../helpers/offline-app';

/**
 * Assistant flow — offline real-browser coverage. The headline assertion is
 * the human-approval gate (a repo invariant: proposals are NEVER
 * auto-executed): the proposal card renders with an explicit Approve control,
 * and NO approve call fires until the operator clicks it.
 */

const COMPOSER = 'Ask anything or give a command…';

test.describe('offline — assistant flow', () => {
  test('sending a message posts the typed text and renders the reply', async ({
    page,
    offlineApp,
  }) => {
    const tracker: ApiTrackerEntry[] = [];
    await installAssistantMocks(page, tracker, { withProposal: false });

    await page.goto('/assistant');
    const composer = page.getByPlaceholder(COMPOSER);
    await composer.waitFor({ state: 'visible', timeout: DATA_TIMEOUT });
    await composer.fill('Send the Priya estimate');
    await composer.press('Enter');

    await expect
      .poll(() => tracker.filter((t) => t.path === '/api/assistant/chat').length)
      .toBe(1);
    const chat = tracker.find((t) => t.path === '/api/assistant/chat');
    const messages = (chat?.body as { messages?: Array<{ role: string; content: string }> })
      ?.messages;
    expect(messages?.at(-1)).toMatchObject({ role: 'user', content: 'Send the Priya estimate' });

    await expect(page.getByText(/here.s what i can do/i).first()).toBeVisible();
    expect((await offlineApp.clerkCounters()).signOutCalls).toBe(0);
  });

  test('human-approval gate: proposal approves ONLY on click, never before', async ({ page }) => {
    const tracker: ApiTrackerEntry[] = [];
    await installAssistantMocks(page, tracker, { withProposal: true });

    await page.goto('/assistant');
    const composer = page.getByPlaceholder(COMPOSER);
    await composer.waitFor({ state: 'visible', timeout: DATA_TIMEOUT });
    await composer.fill('Send the Priya estimate');
    await composer.press('Enter');

    // The proposal card renders with an explicit Approve control.
    const approve = page.getByRole('button', { name: /^approve$/i });
    await expect(approve).toBeVisible({ timeout: DATA_TIMEOUT });

    // Invariant: nothing is executed before the operator acts.
    expect(tracker.some((t) => t.path.endsWith('/approve'))).toBe(false);

    await approve.click();

    await expect
      .poll(() => tracker.filter((t) => t.path.endsWith('/approve')).length)
      .toBe(1);
    expect(tracker.find((t) => t.path.endsWith('/approve'))?.path).toBe(
      `/api/proposals/${PROPOSAL_ID}/approve`,
    );
  });

  test('dismiss rejects the proposal via the reject endpoint', async ({ page }) => {
    const tracker: ApiTrackerEntry[] = [];
    await installAssistantMocks(page, tracker, { withProposal: true });

    await page.goto('/assistant');
    const composer = page.getByPlaceholder(COMPOSER);
    await composer.waitFor({ state: 'visible', timeout: DATA_TIMEOUT });
    await composer.fill('Send the Priya estimate');
    await composer.press('Enter');

    await expect(page.getByRole('button', { name: /dismiss/i })).toBeVisible({
      timeout: DATA_TIMEOUT,
    });
    await page.getByRole('button', { name: /dismiss/i }).click();

    await expect
      .poll(() => tracker.filter((t) => t.path.endsWith('/reject')).length)
      .toBe(1);
    expect(tracker.find((t) => t.path.endsWith('/reject'))?.path).toBe(
      `/api/proposals/${PROPOSAL_ID}/reject`,
    );
  });

  test('chat 500 surfaces a connection error without an auth exit', async ({
    page,
    offlineApp,
  }) => {
    const tracker: ApiTrackerEntry[] = [];
    await installAssistantMocks(page, tracker);
    // Override chat to fail (registered last → wins).
    await page.route(
      (url) => url.pathname === '/api/assistant/chat',
      (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
          : route.fallback(),
    );

    await page.goto('/assistant');
    const composer = page.getByPlaceholder(COMPOSER);
    await composer.waitFor({ state: 'visible', timeout: DATA_TIMEOUT });
    await composer.fill('Send the Priya estimate');
    await composer.press('Enter');

    // sendChat catches the non-OK response and renders an accurate,
    // non-misleading fallback message rather than crashing.
    await expect(page.getByText(/unable to connect to ai service/i).first()).toBeVisible({
      timeout: DATA_TIMEOUT,
    });
    expect((await offlineApp.clerkCounters()).signOutCalls).toBe(0);
  });
});
