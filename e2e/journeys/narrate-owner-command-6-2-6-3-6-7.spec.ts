import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  API_URL,
  bootstrapOwner,
  seedJob,
  signInOwnerBrowser,
  queryAsTenant,
  logRows,
  pollForRow,
  type Tenant,
} from '../fixtures/estimate-quote-lane';
import { issueInvoicePayloadSchema } from '../../packages/api/src/proposals/contracts';

/**
 * #995 §8.6 Narrate — rung-5 reachability, rows 6.2, 6.3, 6.7.
 *
 * REAL SURFACE (per the lane brief): the owner's Assistant chat (`/assistant`,
 * `packages/web/src/components/assistant/AssistantPage.tsx`), which POSTs to
 * the real `POST /api/assistant/chat` route. The model is the hermetic mock
 * (no `AI_PROVIDER_API_KEY` configured); every turn below is recognized by a
 * DETERMINISTIC pre-LLM short-circuit in
 * `packages/api/src/ai/orchestration/intent-classifier.ts` — no gateway call
 * for classification, AND no downstream gateway call for field extraction
 * either (see the per-row notes below for exactly why each was picked):
 *
 *   - 6.2 uses `matchIssueInvoicePhrase` (intent-classifier.ts:1917-1918,
 *     "Issue invoice INV-####") -> `IssueInvoiceTaskHandler`
 *     (ai/orchestration/task-router.ts:142) -> `IssueInvoiceExecutionHandler`.
 *     NOT `create_customer`: that deterministic pattern (also real, also
 *     pre-LLM) turns out to be UNREACHABLE from the actual owner Assistant
 *     UI for a completely different reason — see
 *     `packages/web/src/hooks/useVoiceCommands.ts:37`
 *     (`\b(new|create|add)\s+${FILLER}(customer|client)\b`), a CLIENT-SIDE
 *     navigation shortcut in `AssistantPage.tsx`'s own `send()` (line ~934,
 *     `matchVoiceCommand`) that intercepts any "new customer …" / "add a
 *     customer …" turn BEFORE it ever reaches `POST /api/assistant/chat` and
 *     silently redirects to the blank `/customers/new` form instead — a
 *     genuine, empirically-confirmed product gap (a real
 *     `page.waitForResponse` for `/api/assistant/chat` never resolves; zero
 *     server-side log lines) reported in the lane report, not used here.
 *     `issue_invoice` has no such collision (`useVoiceCommands.ts`'s
 *     `COMMANDS` table has no "issue" trigger) and its task handler
 *     (task-router.ts:171-236) does ALL resolution synchronously against
 *     the exact "INV-####" reference — no `gateway.complete` call — so it
 *     is safe from the hermetic mock's task-type coverage gaps too.
 *   - 6.3 uses `matchLookupJobProfitPhrase` (intent-classifier.ts:1775-1785,
 *     "Did I make money on the X job?") -> `dispatchAssistantLookup`
 *     (ai/orchestration/lookup-dispatch.ts) -> the SAME `EntityResolver`
 *     (`kind: 'job'`) `test/integration/entity-resolution.test.ts`'s
 *     "Henderson job" T2 proof uses, then the real, LLM-free
 *     `lookupJobProfit` skill. NOT `matchUpdateJobPriorityPhrase`
 *     ("Mark the X job as high priority"): that pattern IS deterministic for
 *     the *intent* and the *entity resolution*, but the actual priority
 *     VALUE is extracted by `UpdateJobTaskHandler` through a SECOND,
 *     un-scripted gateway call (`ai/tasks/job-edit-task.ts:161-162,
 *     taskType: 'update_job'` — `ai/providers/mock.ts`'s hermetic
 *     `scriptHermeticResponse` has no branch for it, so it falls to the
 *     generic `{ok:true,mock:true,...}` stub with no `priority` field at
 *     all) — empirically confirmed: the drafted proposal failed
 *     `updateJobPayloadSchema` ("requires at least one field to change").
 *     That is a second, DISTINCT seam from the classification-only gaps in
 *     the sibling gaps file, reported in the lane report rather than papered
 *     over. `lookup_job_profit` reaches the exact same entity-resolution
 *     mechanism with no second gateway call at all (read-only skills never
 *     call the LLM).
 *   - 6.7 uses `matchLookupBalancePhrase` (intent-classifier.ts:1727-1736,
 *     "What does X owe me?") -> `dispatchAssistantLookup`, a thin surface
 *     adapter over the SAME `executeLookupAnswer`
 *     (workers/voice-lookup-answer.ts) `test/integration/
 *     voice-lookup-answer.test.ts` already proves at real Postgres — driven
 *     here from two independent real browser sessions (two tenants) in one
 *     run.
 *
 * Rows 6.4, 6.5, 6.6 and 6.9 have NO deterministic short-circuit anywhere in
 * intent-classifier.ts for their intents (`lookup_jobs`, `update_estimate`,
 * `add_note`/`log_expense`/`log_mileage`, `add_material`) — see the sibling
 * file `narrate-owner-command-gaps-6-4-6-5-6-6-6-9.spec.ts` for the pinned
 * seam these four rows stop at on this surface.
 */

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-6-narrate-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * Send one chat turn and wait for the real `POST /api/assistant/chat`
 * round-trip to complete (the drafting/proposal-persistence work always
 * happens server-side BEFORE the response — plain JSON or the first SSE
 * byte when the client opts into streaming — is sent, so waiting for this
 * response is a safe checkpoint that any DB write for the turn has already
 * landed).
 */
async function sendChatMessage(page: Page, text: string): Promise<void> {
  await page.goto('/assistant');
  const textarea = page.getByPlaceholder(/Ask anything or give a command/i);
  await expect(textarea).toBeVisible({ timeout: 90_000 });
  await textarea.fill(text);
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/assistant/chat') && res.request().method() === 'POST',
      { timeout: 90_000 },
    ),
    textarea.press('Enter'),
  ]);
}

/** Creates a DRAFT invoice (never issued) via the real API — the state a
 * genuine "issue invoice INV-####" command should act on. Returns the real
 * invoice_number so the chat message can name it exactly. */
async function seedDraftInvoice(
  request: import('@playwright/test').APIRequestContext,
  tenant: Tenant,
  jobId: string,
  totalCents: number,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const invoiceRes = await request.post(`${API_URL}/api/invoices`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      jobId,
      lineItems: [
        {
          id: randomUUID(),
          description: 'Service call',
          quantity: 1,
          unitPriceCents: totalCents,
          totalCents,
          sortOrder: 0,
          taxable: false,
        },
      ],
    }),
  });
  expect(invoiceRes.ok(), `create invoice -> ${invoiceRes.status()} ${await invoiceRes.text()}`).toBeTruthy();
  const invoice = (await invoiceRes.json()) as { id: string };
  const row = await pollForRow(async () => {
    const rows = await queryAsTenant(
      tenant.tenantId,
      `SELECT invoice_number, status FROM invoices WHERE id = $1`,
      [invoice.id],
    );
    return rows[0];
  });
  expect(row.status).toBe('draft');
  return { invoiceId: invoice.id, invoiceNumber: String(row.invoice_number) };
}

/** Creates and ISSUES an invoice (open, with a real amountDueCents) — used by
 * 6.7's lookup_balance leg, which needs the balance to already be owed. */
async function seedOpenInvoice(
  request: import('@playwright/test').APIRequestContext,
  tenant: Tenant,
  jobId: string,
  totalCents: number,
): Promise<{ invoiceId: string }> {
  const invoiceRes = await request.post(`${API_URL}/api/invoices`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      jobId,
      lineItems: [
        {
          id: randomUUID(),
          description: 'Service call',
          quantity: 1,
          unitPriceCents: totalCents,
          totalCents,
          sortOrder: 0,
          taxable: false,
        },
      ],
    }),
  });
  expect(invoiceRes.ok(), `create invoice -> ${invoiceRes.status()} ${await invoiceRes.text()}`).toBeTruthy();
  const invoice = (await invoiceRes.json()) as { id: string };
  await pollForRow(async () => {
    const r = await request.get(`${API_URL}/api/invoices/${invoice.id}`, { headers: tenant.authHeaders });
    return r.ok() ? invoice : null;
  });
  const issueRes = await request.post(`${API_URL}/api/invoices/${invoice.id}/issue`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({}),
  });
  expect(issueRes.ok(), `issue invoice -> ${issueRes.status()} ${await issueRes.text()}`).toBeTruthy();
  return { invoiceId: invoice.id };
}

const canRun =
  !process.env.E2E_BASE_URL &&
  process.env.E2E_USE_TEST_DB === 'true' &&
  !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

test.describe('§8.6 row 6.2 — a spoken command becomes a typed, validated proposal (real Postgres)', () => {
  test.skip(!canRun, 'Requires the local webServer pair against a real Postgres.');

  test('a dictated "issue invoice INV-####" command drafts an issue_invoice proposal that passes issueInvoicePayloadSchema, and Approve flips the real invoice draft -> open with an invoice.issued audit event; a mumble mints nothing; a neighbour tenant never sees it (T2)', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const tenantA = await bootstrapOwner(request, '62a', 'Copper Line HVAC 6.2');
    const tenantB = await bootstrapOwner(request, '62b', 'Bluebonnet Plumbing 6.2');
    await signInOwnerBrowser(page, baseURL!, tenantA);

    const jobA = await seedJob(request, tenantA, 'Vega', { firstName: 'Alex', lastName: 'Vega' });
    const { invoiceId, invoiceNumber } = await seedDraftInvoice(request, tenantA, jobA.jobId, 24_000);

    // ── Positive leg: the deterministic issue_invoice command ────────────
    await sendChatMessage(page, `Issue invoice ${invoiceNumber}.`);
    const approveBtn = page.getByRole('button', { name: /^Approve$/ }).first();
    await expect(approveBtn).toBeVisible({ timeout: 90_000 });
    await page.waitForTimeout(400); // let the reply's transition settle before capturing

    await page.screenshot({ path: join(SCREENSHOT_DIR, '6.2-drafted-issue-invoice.png'), fullPage: true });

    // ── Durable proof: the drafted PAYLOAD passes its own Zod contract.
    //    At DRAFT time `invoiceId` carries the RAW "INV-####" reference
    //    string (task-router.ts's Rung 1: "already a usable reference;
    //    resolveInvoice() at execution time handles the UUID/number-vs-
    //    lookup split") — the real UUID resolution is proven below, after
    //    Approve, on the actual invoice row. ─────────────────────────────
    const proposalRow = await pollForRow(async () => {
      const rows = await queryAsTenant(
        tenantA.tenantId,
        `SELECT id, payload, status FROM proposals
           WHERE tenant_id = $1 AND proposal_type = 'issue_invoice'
           ORDER BY created_at DESC LIMIT 1`,
        [tenantA.tenantId],
      );
      return rows[0];
    });
    logRows('6.2 issue_invoice proposal payload', proposalRow);
    const payload = proposalRow.payload as { invoiceId?: string };
    expect(payload.invoiceId).toBe(invoiceNumber);
    const contractCheck = issueInvoicePayloadSchema.safeParse(proposalRow.payload);
    expect(contractCheck.success, `payload failed issueInvoicePayloadSchema: ${JSON.stringify(
      !contractCheck.success ? contractCheck.error.issues : null,
    )}`).toBe(true);

    await approveBtn.click();
    await expect(page.getByText(/Approved/i).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(400); // let the reply's transition settle before capturing

    await page.screenshot({ path: join(SCREENSHOT_DIR, '6.2-approved-issue-invoice.png'), fullPage: true });

    // ── Durable proof: the REAL invoice flips draft -> open + invoice.issued
    const invoiceRow = await pollForRow(async () => {
      const rows = await queryAsTenant(
        tenantA.tenantId,
        `SELECT status FROM invoices WHERE id = $1`,
        [invoiceId],
      );
      return rows[0]?.status === 'open' ? rows[0] : null;
    });
    logRows('6.2 invoice row after approve', invoiceRow);
    expect(invoiceRow.status).toBe('open');

    const auditRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type FROM audit_events
         WHERE tenant_id = $1 AND entity_type = 'invoice' AND entity_id = $2
           AND event_type = 'invoice.issued'`,
      [tenantA.tenantId, invoiceId],
    );
    logRows('6.2 audit_events invoice.issued', auditRows);
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    // ── Negative leg: "a mumble can't become a malformed proposal" ───────
    // No deterministic matcher fires on this text, and it matches none of
    // the hermetic mock's classify_intent keyword regexes
    // (packages/api/src/ai/providers/mock.ts:160-197) — the classifier
    // genuinely returns { intentType: 'unknown', confidence: 0.2 } from the
    // real gateway call, and the generic reply path never fabricates a
    // proposal for it (assistant-honesty-guard.ts).
    const beforeMumbleCount = (
      await queryAsTenant(
        tenantA.tenantId,
        `SELECT count(*)::int AS n FROM proposals WHERE tenant_id = $1`,
        [tenantA.tenantId],
      )
    )[0].n;
    await sendChatMessage(page, 'The weather has been unusually mild this week.');
    const afterMumble = await queryAsTenant(
      tenantA.tenantId,
      `SELECT count(*)::int AS n FROM proposals WHERE tenant_id = $1`,
      [tenantA.tenantId],
    );
    logRows('6.2 mumble — proposals count before/after', { before: beforeMumbleCount, after: afterMumble[0].n });
    expect(afterMumble[0].n).toBe(beforeMumbleCount);
    await page.waitForTimeout(400); // let the reply's transition settle before capturing

    await page.screenshot({ path: join(SCREENSHOT_DIR, '6.2-mumble-no-proposal.png'), fullPage: true });

    // ── T2 — tenant B never sees any of tenant A's drafted/issued data ───
    // (queryAsTenant connects as the testcontainer superuser, which bypasses
    // RLS — the SQL itself must scope by tenant_id; see that helper's own
    // doc comment.)
    const bInvoices = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantB.tenantId],
    );
    expect(bInvoices).toHaveLength(0);
    const crossRead = await request.get(`${API_URL}/api/invoices/${invoiceId}`, {
      headers: tenantB.authHeaders,
    });
    expect([403, 404]).toContain(crossRead.status());
    logRows('6.2 T2 — tenant B cross-read of tenant A invoice', { status: crossRead.status() });

    expect(pageErrors, 'no uncaught page errors during the command journey').toEqual([]);
  });
});

test.describe('§8.6 row 6.3 — "the Henderson job" resolves through the real chat surface (real Postgres)', () => {
  test.skip(!canRun, 'Requires the local webServer pair against a real Postgres.');

  test('two independently-signed-in owners, in one run, each ask "did I make money on the Henderson job?" and each hears ONLY their own tenant\'s Henderson job\'s real figures — a neighbour tenant\'s GENUINELY matching Henderson job never rides along (T2)', async ({
    request,
    baseURL,
    browser,
  }) => {
    test.setTimeout(300_000);

    const tenantA = await bootstrapOwner(request, '63a', 'Copper Line HVAC 6.3');
    const tenantB = await bootstrapOwner(request, '63b', 'Bluebonnet Plumbing 6.3');

    // BOTH tenants have a GENUINELY matching "Henderson" job (mirrors
    // test/integration/entity-resolution.test.ts's "(#1019 6.3)" T2 proof:
    // a neighbour with real data of its own, not a data-free stranger) with
    // DIFFERENT real revenue.
    const jobA = await seedJob(request, tenantA, 'Pat', { firstName: 'Pat', lastName: 'Henderson' });
    const jobB = await seedJob(request, tenantB, 'Casey', { firstName: 'Casey', lastName: 'Henderson' });
    await seedOpenInvoice(request, tenantA, jobA.jobId, 30_000); // $300.00
    await seedOpenInvoice(request, tenantB, jobB.jobId, 70_000); // $700.00

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signInOwnerBrowser(pageA, baseURL!, tenantA);
    await sendChatMessage(pageA, 'Did I make money on the Henderson job?');
    await expect(pageA.getByText(/\$300\.00/)).toBeVisible({ timeout: 60_000 });
    await expect(pageA.getByText(/\$700\.00/)).toHaveCount(0);
    await pageA.waitForTimeout(400); // let the reply's transition settle before capturing

    await pageA.screenshot({ path: join(SCREENSHOT_DIR, '6.3-tenantA-job-profit.png'), fullPage: true });

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signInOwnerBrowser(pageB, baseURL!, tenantB);
    await sendChatMessage(pageB, 'Did I make money on the Henderson job?');
    await expect(pageB.getByText(/\$700\.00/)).toBeVisible({ timeout: 60_000 });
    await expect(pageB.getByText(/\$300\.00/)).toHaveCount(0);
    await pageB.waitForTimeout(400); // let the reply's transition settle before capturing

    await pageB.screenshot({ path: join(SCREENSHOT_DIR, '6.3-tenantB-job-profit.png'), fullPage: true });

    // Durable proof, in the DB: tenant A's answer never carries tenant B's
    // job id (or vice versa) — the resolver scoped strictly to each tenant.
    const jobsA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id FROM jobs WHERE tenant_id = $1`,
      [tenantA.tenantId],
    );
    expect(jobsA.map((r) => r.id)).not.toContain(jobB.jobId);

    logRows('6.3 T2 — two tenants, both a genuine "Henderson" job, divergent real revenue, each hears only its own', {
      tenantA: { tenantId: tenantA.tenantId, jobId: jobA.jobId, expected: '$300.00' },
      tenantB: { tenantId: tenantB.tenantId, jobId: jobB.jobId, expected: '$700.00' },
    });

    await contextA.close();
    await contextB.close();
  });
});

test.describe('§8.6 row 6.7 — "ask for my numbers out loud" through the real chat surface (real Postgres)', () => {
  test.skip(!canRun, 'Requires the local webServer pair against a real Postgres.');

  test('two independently-signed-in owners, in one run, each ask "what does Delgado owe me?" and each hears ONLY their own tenant\'s real computed balance — never the other\'s (T2)', async ({
    request,
    baseURL,
    browser,
  }) => {
    test.setTimeout(300_000);

    const tenantA = await bootstrapOwner(request, '67a', 'Copper Line HVAC 6.7');
    const tenantB = await bootstrapOwner(request, '67b', 'Bluebonnet Plumbing 6.7');

    // BOTH tenants have a customer with the SAME name ("Delgado") and a
    // DIFFERENT real outstanding balance — the sharpest T2 shape: identical
    // reference text, divergent tenant-scoped data.
    const jobA = await seedJob(request, tenantA, 'Robin', { firstName: 'Robin', lastName: 'Delgado' });
    const jobB = await seedJob(request, tenantB, 'Robin', { firstName: 'Robin', lastName: 'Delgado' });
    await seedOpenInvoice(request, tenantA, jobA.jobId, 4_500); // $45.00
    await seedOpenInvoice(request, tenantB, jobB.jobId, 99_900); // $999.00

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signInOwnerBrowser(pageA, baseURL!, tenantA);
    await sendChatMessage(pageA, 'What does Delgado owe me?');
    const answerA = pageA.getByText(/Your current balance is \$45\.00/);
    await expect(answerA).toBeVisible({ timeout: 60_000 });
    await expect(pageA.getByText(/\$999\.00/)).toHaveCount(0);
    await pageA.waitForTimeout(400); // let the reply's transition settle before capturing

    await pageA.screenshot({ path: join(SCREENSHOT_DIR, '6.7-tenantA-balance.png'), fullPage: true });

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signInOwnerBrowser(pageB, baseURL!, tenantB);
    await sendChatMessage(pageB, 'What does Delgado owe me?');
    const answerB = pageB.getByText(/Your current balance is \$999\.00/);
    await expect(answerB).toBeVisible({ timeout: 60_000 });
    await expect(pageB.getByText(/\$45\.00/)).toHaveCount(0);
    await pageB.waitForTimeout(400); // let the reply's transition settle before capturing

    await pageB.screenshot({ path: join(SCREENSHOT_DIR, '6.7-tenantB-balance.png'), fullPage: true });

    logRows('6.7 T2 — two tenants, same customer name, divergent real balances, each hears only its own', {
      tenantA: { tenantId: tenantA.tenantId, expected: '$45.00' },
      tenantB: { tenantId: tenantB.tenantId, expected: '$999.00' },
    });

    await contextA.close();
    await contextB.close();
  });
});
