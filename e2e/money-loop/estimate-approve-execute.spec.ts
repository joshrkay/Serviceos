/**
 * W1-1 — Hermetic: estimate approve → execute
 *
 * Proves the AI OS loop in CI without Clerk cloud or a live LLM:
 *   pending estimate proposal → owner Approve in Inbox → executed
 *
 * Approach:
 *   - Offline Clerk stub + shell mocks (e2e/helpers/offline-app.ts)
 *   - Seeded ready_for_review draft_estimate (no AI_PROVIDER_API_KEY)
 *   - Drive Approve on real Inbox SPA
 *   - Assert approve POST + advanceExecution() → status=executed
 *   - No multi-minute sleeps; undo toast is asserted then worker is mocked
 *
 * Plan: docs/plans/wave1/W1-1-estimate-approve-execute.md
 */

import { test, expect } from '../helpers/offline-app';
import {
  advanceExecution,
  createEstimateProposalState,
  ESTIMATE_PROPOSAL_ID,
  installProposalMocks,
  RESULT_ESTIMATE_ID,
  type ProposalMockTrackers,
} from '../helpers/api-mocks/proposals';

test.describe('W1-1 — hermetic estimate approve → execute', () => {
  test('Inbox Approve posts, undo toast shows, proposal reaches executed', async ({
    page,
    apiTracker,
    trackMutation,
    pageErrors,
  }) => {
    const state = createEstimateProposalState();
    const trackers: ProposalMockTrackers = { approvePosts: [], getDetailHits: 0 };
    await installProposalMocks(page, state, trackers, trackMutation);

    // No approve call may fire before the operator clicks.
    expect(trackers.approvePosts).toHaveLength(0);

    await page.goto('/inbox');

    await expect(page.getByText(/replace water heater/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('inbox-row')).toBeVisible();

    // Human-approval gate: Approve is explicit; click it.
    const approveBtn = page.getByRole('button', { name: /^approve$/i });
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // Approve POST fired exactly once with the seeded id.
    await expect.poll(() => trackers.approvePosts.length).toBe(1);
    expect(trackers.approvePosts[0].id).toBe(ESTIMATE_PROPOSAL_ID);
    expect(
      apiTracker.some(
        (m) =>
          m.method === 'POST' &&
          m.path === `/api/proposals/${ESTIMATE_PROPOSAL_ID}/approve`,
      ),
    ).toBe(true);
    expect(state.status).toBe('approved');

    // D5 undo toast appears (5s window) — prove UI wiring without sleeping 5s.
    await expect(page.getByTestId('undo-toast')).toBeVisible();
    await expect(page.getByText(/to undo/i)).toBeVisible();

    // Row leaves the pending feed optimistically.
    await expect(page.getByTestId('inbox-row')).toHaveCount(0);

    // Simulate execution worker after undo window (test hook — no sleep).
    advanceExecution(state);
    expect(state.status).toBe('executed');
    expect(state.resultEntityId).toBe(RESULT_ESTIMATE_ID);

    // Proposal detail reflects executed + result entity (journey assertion).
    // page.request bypasses page.route — use in-page fetch via evaluate.
    const proposal = await page.evaluate(async (id) => {
      const res = await fetch(`/api/proposals/${id}`);
      return res.json();
    }, ESTIMATE_PROPOSAL_ID);

    expect(proposal.status).toBe('executed');
    expect(proposal.resultEntityId).toBe(RESULT_ESTIMATE_ID);

    // Estimates list shows the created estimate after execution.
    await page.goto('/estimates');
    await expect(page.getByText('EST-9001').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/dana diaz/i).first()).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('never auto-executes — approve POST only after click', async ({
    page,
    trackMutation,
  }) => {
    const state = createEstimateProposalState();
    const trackers: ProposalMockTrackers = { approvePosts: [], getDetailHits: 0 };
    await installProposalMocks(page, state, trackers, trackMutation);

    await page.goto('/inbox');
    await expect(page.getByText(/replace water heater/i)).toBeVisible({
      timeout: 15_000,
    });

    // Settle past initial pollers — still zero approve posts.
    await page.waitForTimeout(1_500);
    expect(trackers.approvePosts).toHaveLength(0);
    expect(state.status).toBe('ready_for_review');
  });
});
