import { test, expect } from '@playwright/test';

/**
 * Journey 2 — AI-generated estimate proposal is reviewed, approved, and executed.
 *
 * Why this matters:
 *   This is the core proposal engine loop — the thing that makes ServiceOS
 *   an "AI OS" and not just a CRM. Covers: AI task produces a proposal,
 *   it persists to PG, operator reviews/edits it, approves, 5s undo window,
 *   auto-delivery worker picks it up, executes, creates the estimate row.
 *
 * Current status: SKIPPED.
 *
 * To enable this test we need:
 *   1. Everything Journey 1 needs (authed Clerk session, tenant, PG)
 *   2. AI provider credentials in CI (AI_PROVIDER_API_KEY pointing at a
 *      test key with strict rate limits) OR a mocked AI gateway that
 *      returns a canned proposal payload
 *   3. Test fixtures that pre-seed a customer + job so the estimate has
 *      context to attach to
 *   4. Clock control for the 5s undo window — either real-time waits
 *      (slow but realistic) or an API hook that advances `approvedAt`
 */

test.describe('Journey 2 — estimate proposal approval + execution', () => {
  test.skip('AI-drafted estimate can be reviewed, approved, and executed', async ({ page }) => {
    // Preconditions: logged in as tenant owner, test customer/job exist.
    // TODO: fixture setup via API as authed user.

    // 1. Trigger an AI estimate draft.
    //    In the product, this happens when a technician's voice note
    //    references pricing. For E2E, post directly to the draft endpoint.
    const draftRes = await page.request.post('/api/ai/tasks/estimate/draft', {
      data: {
        jobId: 'e2e-test-job-id',
        context: 'replace water heater, 50 gallon electric',
      },
    });
    expect(draftRes.status()).toBe(200);
    const { proposalId } = await draftRes.json();

    // 2. Operator opens the proposal inbox and sees the new draft.
    await page.goto('/assistant');
    await expect(page.getByText(/draft|proposal/i).first()).toBeVisible({ timeout: 10_000 });

    // 3. Open the proposal, verify summary + line items rendered.
    await page.getByTestId(`proposal-${proposalId}`).click();
    await expect(page.getByText(/water heater/i)).toBeVisible();

    // 4. Approve. Expect the 5s undo countdown to appear.
    await page.getByRole('button', { name: /approve/i }).click();
    await expect(page.getByText(/undo/i)).toBeVisible();

    // 5. Wait past the undo window (or fast-forward via test hook).
    //    D9 says approvedAt + 5000ms before executor claims.
    await page.waitForTimeout(6000);

    // 6. Verify the auto-delivery worker executed it and an estimate row
    //    now exists in the estimates list.
    await page.goto('/estimates');
    await expect(page.getByText(/water heater/i)).toBeVisible({ timeout: 15_000 });

    // 7. Verify the proposal status is now "executed" via API.
    const proposalRes = await page.request.get(`/api/proposals/${proposalId}`);
    const proposal = await proposalRes.json();
    expect(proposal.status).toBe('executed');
    expect(proposal.resultEntityId).toBeTruthy();
  });
});
