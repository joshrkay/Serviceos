import { test, expect } from '@playwright/test';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { API_URL, bootstrapOwner, seedCustomerJob, queryAsTenant } from '../fixtures/money-lane-8-8';

/**
 * 8.11 — rung-5 reachability: "bill a big job in stages". PR #1053's
 * `integration/milestone-billing.test.ts` already proves the split-math +
 * minting invariants at real Postgres (T1) by constructing the
 * `create_invoice_schedule` proposal DIRECTLY, in-process
 * (`CreateInvoiceScheduleExecutionHandler.execute(...)`) — never through a
 * real authenticated request.
 *
 * ── Reachability audit (read before changing this file) ─────────────────
 * `create_invoice_schedule` is created EXACTLY ONE way in production: the
 * classify_intent -> task-handler voice/assistant pipeline
 * (proposals/voice-intent-map.ts:163). `POST /api/proposals`
 * (routes/proposals.ts:104-122) explicitly refuses it — its own comment
 * says "AI-originated proposal types are created via the LLM gateway, not
 * this HTTP path" and its `SUPPORTED_TYPES` allowlist (reschedule/
 * reassign/add/remove-crew) does not include it. There is no other REST
 * route, and packages/web has no schedule-authoring UI (grepped).
 *
 * Unlike `create_invoice` (8.1) or `apply_late_fee`/`issue_invoice` (8.9/
 * 8.10), `create_invoice_schedule` has NO deterministic
 * `classifyIntentRaw` matcher AND no `mock.ts` `scriptHermeticResponse`
 * entry for `classify_intent` (grepped both files) — a milestone-plan
 * sentence therefore falls through to the hermetic mock's own catch-all,
 * `{"intentType":"unknown","confidence":0.2}`, exactly the same
 * documented stop this lane's sibling spec
 * (e2e/journeys/log-time-by-voice.spec.ts) hit for `log_time_entry`. This
 * is a REAL capability gap, not a test artifact: closing it needs EITHER a
 * live `AI_PROVIDER_API_KEY` (#1119, out of scope for this lane) OR a
 * deterministic matcher/mock-script addition to packages/api/src — a
 * product-code change this test-only lane may not make.
 *
 * This spec proves everything hermetically reachable up to that seam (a
 * real owner-authenticated milestone-plan sentence, posted to the real
 * `/api/assistant/chat` route, against a job with `milestoneBillingEnabled`
 * turned on for real via `PUT /api/settings`) and then PINS the stop: no
 * `create_invoice_schedule` proposal, no `invoice_schedules` row, no
 * milestone invoice ever mints. The split-math itself (Σ milestones ===
 * total, remainder absorbs the stray cent) stays PROVEN-REAL-DB only via
 * the in-process vitest path (PR #1053) — that half of the story is
 * unchanged by this spec and is not re-asserted here.
 */

test.describe('bill in stages — the real stop point (8.11) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !process.env.AI_PROVIDER_API_KEY;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container, and leave AI_PROVIDER_API_KEY UNSET (this row\'s whole ' +
      'finding rests on the hermetic no-key mock gateway).',
  );

  test('a real milestone-plan sentence to the owner assistant never becomes a create_invoice_schedule proposal — classification never reaches it without a live model', async ({
    request,
  }) => {
    test.setTimeout(60_000);

    const tenant = await bootstrapOwner(request, 'a', 'Staged Billing HVAC 8.11');
    const enableRes = await request.put(`${API_URL}/api/settings`, {
      headers: { 'content-type': 'application/json', ...tenant.authHeaders },
      data: JSON.stringify({ milestoneBillingEnabled: true }),
    });
    expect(enableRes.ok(), `PUT settings -> ${enableRes.status()}`).toBeTruthy();
    const settingsAfter = await request.get(`${API_URL}/api/settings`, { headers: tenant.authHeaders });
    expect(((await settingsAfter.json()) as { milestoneBillingEnabled?: boolean }).milestoneBillingEnabled).toBe(true);

    const seed = await seedCustomerJob(request, tenant, 'Morgan', '8.11 staged-billing journey');

    const chatRes = await request.post(`${API_URL}/api/assistant/chat`, {
      headers: { 'content-type': 'application/json', ...tenant.authHeaders },
      data: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: 'Bill this job in three stages: a third now, a third at halfway, and the rest on completion.',
          },
        ],
      }),
    });
    // The route itself is reached and answers — it does not error. The
    // classification result is what stops short (asserted below).
    expect(chatRes.ok(), `assistant/chat -> ${chatRes.status()} ${await chatRes.text()}`).toBeTruthy();

    // Give the (synchronous) drafting path a moment, then confirm the honest
    // negative: no schedule proposal, no schedule row, ever.
    await new Promise((r) => setTimeout(r, 500));
    const scheduleProposals = await queryAsTenant(
      tenant.tenantId,
      `SELECT id FROM proposals WHERE tenant_id = $1 AND proposal_type = 'create_invoice_schedule'`,
      [tenant.tenantId],
    );
    expect(scheduleProposals, 'no create_invoice_schedule proposal was ever drafted — the classification seam').toHaveLength(0);

    const scheduleRows = await queryAsTenant(
      tenant.tenantId,
      `SELECT id FROM invoice_schedules WHERE tenant_id = $1 AND job_id = $2`,
      [tenant.tenantId, seed.jobId],
    );
    expect(scheduleRows, 'no invoice_schedules row exists for this job').toHaveLength(0);

    const milestoneInvoices = await queryAsTenant(
      tenant.tenantId,
      `SELECT id FROM invoices WHERE tenant_id = $1 AND job_id = $2 AND milestone_index IS NOT NULL`,
      [tenant.tenantId, seed.jobId],
    );
    expect(milestoneInvoices, 'no milestone invoice was ever minted').toHaveLength(0);
  });
});
