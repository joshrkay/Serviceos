import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  API_URL,
  bootstrapOwner,
  seedJob,
  createEstimate,
  signInOwnerBrowser,
  queryAsTenant,
  logRows,
  type Tenant,
} from '../fixtures/estimate-quote-lane';

/**
 * #995 §8.6 Narrate — rung-5 reachability, rows 6.4, 6.5, 6.6, 6.9.
 *
 * These four rows have NO deterministic pre-LLM short-circuit anywhere in
 * `packages/api/src/ai/orchestration/intent-classifier.ts` for their
 * classified intent (`lookup_jobs`, `update_estimate`, `add_note` /
 * `log_expense` / `log_mileage`, `add_material`). The complete inventory of
 * exported `match*Phrase` functions in that file (grep `^export function
 * match`) is: matchExtendedIntentPhrase, matchEnRoutePhrase,
 * matchLookupEstimatesPhrase, matchDraftEstimatePhrase,
 * matchLookupBalancePhrase, matchLookupAccountSummaryPhrase,
 * matchLookupJobProfitPhrase, matchNewBookingPhrase, matchIssueInvoicePhrase,
 * matchUpdateJobPriorityPhrase, matchAddCrewMemberPhrase,
 * matchApplyLateFeePhrase — none of them classify a job-status question, an
 * estimate line-item edit, a note/expense/mileage entry, or a material
 * request. `EXTENDED_INTENT_PHRASES`'s own doc comment
 * (intent-classifier.ts:1467-1479) rules this out explicitly: "Any intent
 * that produces entities or drives a proposal ... MUST NOT appear here."
 *
 * On the REAL chat surface (`POST /api/assistant/chat`) with no
 * `AI_PROVIDER_API_KEY` configured, a message for one of these four intents
 * therefore reaches the real gateway call, and the hermetic mock
 * (`packages/api/src/ai/providers/mock.ts`, `scriptHermeticResponse`'s
 * `classify_intent` branch, lines 160-197) only deterministically classifies
 * `create_customer` / `draft_estimate` / `create_invoice` from keyword
 * regexes — everything else, including every phrase below, falls to
 * `{ intentType: 'unknown', confidence: 0.2 }`. The DOWNSTREAM execution for
 * all four intents is fully wired and already proven at real Postgres
 * (`CHAT_INTENT_TO_REGISTRY_KEY` in routes/assistant.ts maps
 * `update_estimate` (:2150), `add_note` (:2168), `log_expense` (:2170) and
 * `add_material` (:2188) to real handlers; `lookup_jobs`'s case lives at
 * workers/voice-lookup-answer.ts:494) — the seam is ENTIRELY the upstream
 * classification step having no live model to consult and no deterministic
 * short-circuit written for it yet. Per the lane brief: "If a row's
 * capability needs a real model ... do not fake it. Reach as far as the real
 * surface goes, pin the stop point with test.fail() naming the seam."
 *
 * Each test below drives the REAL, unmodified `POST /api/assistant/chat`
 * route (real Postgres, real classifier, the same hermetic mock every other
 * spec in this lane uses) with the row's own acceptance-criterion phrasing,
 * proves the real (non-)effect at real Postgres for two tenants (T2 — the
 * gap's non-effect is at least tenant-isolated), then pins the missing
 * capability with `test.fail()`.
 */

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-6-narrate-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function chatViaApi(
  request: import('@playwright/test').APIRequestContext,
  tenant: Tenant,
  text: string,
): Promise<{ message?: { content?: string; proposal?: unknown } }> {
  const res = await request.post(`${API_URL}/api/assistant/chat`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
  });
  expect(res.ok(), `assistant/chat -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { message?: { content?: string; proposal?: unknown } };
}

async function proposalsCount(tenantId: string): Promise<number> {
  const rows = await queryAsTenant(
    tenantId,
    `SELECT count(*)::int AS n FROM proposals WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0].n as number;
}

const canRun =
  !process.env.E2E_BASE_URL &&
  process.env.E2E_USE_TEST_DB === 'true' &&
  !!process.env.VITE_CLERK_PUBLISHABLE_KEY;

test.describe('§8.6 rows 6.4 / 6.5 / 6.6 / 6.9 — pinned seams on the real chat surface (no live model)', () => {
  test.skip(!canRun, 'Requires the local webServer pair against a real Postgres.');

  test('6.4 — "where does the Garcia job stand?" never reaches lookup_jobs: no proposal minted (genuine, T2), but the real reply never speaks the job\'s real status either (pinned)', async ({
    request,
    page,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    test.fail(
      true,
      'intent-classifier.ts has no deterministic short-circuit for `lookup_jobs` — its own ' +
        'EXTENDED_INTENT_PHRASES doc comment (:1467-1479) rules out any entity-bearing lookup ' +
        'phrasing from this table by design, and no other matcher in the file covers it. On the ' +
        'real chat surface with no AI_PROVIDER_API_KEY, ai/providers/mock.ts:160-197 classifies ' +
        'this exact stereotyped status question as intentType: "unknown" (0.2 confidence), so ' +
        'isLookupIntent() (routes/assistant.ts:2596) never fires and the wired lookup_jobs case ' +
        '(workers/voice-lookup-answer.ts:494) is never reached — the owner gets a generic, ' +
        'data-free reply instead of the job\'s real status.',
    );

    const tenantA = await bootstrapOwner(request, '64a', 'Copper Line HVAC 6.4');
    const tenantB = await bootstrapOwner(request, '64b', 'Bluebonnet Plumbing 6.4');
    const jobA = await seedJob(request, tenantA, 'Garcia', { firstName: 'Alex', lastName: 'Garcia' });
    const jobB = await seedJob(request, tenantB, 'Garcia', { firstName: 'Jamie', lastName: 'Garcia' });

    const jobRowA = (
      await queryAsTenant(tenantA.tenantId, `SELECT status FROM jobs WHERE id = $1`, [jobA.jobId])
    )[0];
    const realStatus = String(jobRowA.status);

    // ── Genuine, real behavior (not the pinned claim): a read-only question
    //    never mints a proposal, for EITHER tenant (T2) ───────────────────
    const beforeA = await proposalsCount(tenantA.tenantId);
    const bodyA = await chatViaApi(request, tenantA, 'Where does the Garcia job stand?');
    const afterA = await proposalsCount(tenantA.tenantId);
    expect(afterA).toBe(beforeA);

    const beforeB = await proposalsCount(tenantB.tenantId);
    const bodyB = await chatViaApi(request, tenantB, 'Where does the Garcia job stand?');
    const afterB = await proposalsCount(tenantB.tenantId);
    expect(afterB).toBe(beforeB);
    // Neither tenant's reply ever mints a proposal, and tenant B's reply
    // (whatever it is) never carries tenant A's job id.
    expect(JSON.stringify(bodyB.message?.content ?? '')).not.toContain(jobA.jobId);

    logRows('6.4 real (non-)answers for both tenants — real job status vs. what the chat actually said', {
      realStatusA: realStatus,
      chatReplyA: bodyA.message?.content,
      chatReplyB: bodyB.message?.content,
    });

    // A representative real-browser screenshot of the actual reply.
    await signInOwnerBrowser(page, baseURL!, tenantA);
    await page.goto('/assistant');
    const textarea = page.getByPlaceholder(/Ask anything or give a command/i);
    await expect(textarea).toBeVisible({ timeout: 90_000 });
    await textarea.fill('Where does the Garcia job stand?');
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/assistant/chat') && res.request().method() === 'POST',
        { timeout: 90_000 },
      ),
      textarea.press('Enter'),
    ]);
    await page.waitForTimeout(400); // let the reply's transition settle before capturing

    await page.screenshot({ path: join(SCREENSHOT_DIR, '6.4-no-real-answer.png'), fullPage: true });

    // ── The pinned claim: the acceptance says the owner HEARS the real
    //    status. Expected to fail against current behavior. ──────────────
    expect(
      bodyA.message?.content ?? '',
      'row 6.4 acceptance: the chat reply should speak the Garcia job\'s real status',
    ).toContain(realStatus);
  });

  test('6.5 — "add two hours of labor to the Garcia estimate" never reaches update_estimate: the estimate is untouched (genuine, T2), and no line for it is ever added (pinned)', async ({
    request,
  }) => {
    test.setTimeout(180_000);
    test.fail(
      true,
      'intent-classifier.ts has no deterministic short-circuit for `update_estimate` anywhere ' +
        'in the file (the complete OWNER_OPERATOR_COMMAND_PATTERNS list has an update_invoice ' +
        'line-item entry, :1376-1383, but no update_estimate equivalent). On the real chat ' +
        'surface with no AI_PROVIDER_API_KEY, mock.ts:160-197 classifies this exact utterance ' +
        'as intentType: "unknown" — CHAT_INTENT_TO_REGISTRY_KEY.update_estimate ' +
        '(routes/assistant.ts:2150) is real and wired, but classify_intent never confidently ' +
        'names it without a live model, so it is never reached from this surface.',
    );

    const tenantA = await bootstrapOwner(request, '65a', 'Copper Line HVAC 6.5');
    const tenantB = await bootstrapOwner(request, '65b', 'Bluebonnet Plumbing 6.5');
    const jobA = await seedJob(request, tenantA, 'Garcia', { firstName: 'Alex', lastName: 'Garcia' });
    const jobB = await seedJob(request, tenantB, 'Garcia', { firstName: 'Jamie', lastName: 'Garcia' });
    const { estimateId: estimateA } = await createEstimate(request, tenantA, jobA, [
      {
        id: randomUUID(),
        description: 'Diagnostic visit',
        quantity: 1,
        unitPriceCents: 9_900,
        totalCents: 9_900,
        sortOrder: 0,
        taxable: false,
      },
    ]);
    const { estimateId: estimateB } = await createEstimate(request, tenantB, jobB, [
      {
        id: randomUUID(),
        description: 'Diagnostic visit',
        quantity: 1,
        unitPriceCents: 9_900,
        totalCents: 9_900,
        sortOrder: 0,
        taxable: false,
      },
    ]);

    const beforeLinesA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT count(*)::int AS n FROM estimate_line_items WHERE estimate_id = $1`,
      [estimateA],
    );
    const beforeProposalsA = await proposalsCount(tenantA.tenantId);
    const bodyA = await chatViaApi(request, tenantA, 'Add two hours of labor to the Garcia estimate.');
    const afterLinesA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT count(*)::int AS n FROM estimate_line_items WHERE estimate_id = $1`,
      [estimateA],
    );
    const afterProposalsA = await proposalsCount(tenantA.tenantId);
    // Genuine, real behavior: the estimate is byte-for-byte untouched and no
    // proposal was minted — the turn genuinely did nothing.
    expect(afterLinesA[0].n).toBe(beforeLinesA[0].n);
    expect(afterProposalsA).toBe(beforeProposalsA);

    // T2 — tenant B's estimate is equally untouched by its own identical ask.
    const beforeLinesB = await queryAsTenant(
      tenantB.tenantId,
      `SELECT count(*)::int AS n FROM estimate_line_items WHERE estimate_id = $1`,
      [estimateB],
    );
    await chatViaApi(request, tenantB, 'Add two hours of labor to the Garcia estimate.');
    const afterLinesB = await queryAsTenant(
      tenantB.tenantId,
      `SELECT count(*)::int AS n FROM estimate_line_items WHERE estimate_id = $1`,
      [estimateB],
    );
    expect(afterLinesB[0].n).toBe(beforeLinesB[0].n);

    logRows('6.5 estimate_line_items before/after the real chat command (both tenants untouched)', {
      tenantA: { before: beforeLinesA[0].n, after: afterLinesA[0].n },
      tenantB: { before: beforeLinesB[0].n, after: afterLinesB[0].n },
      chatReplyA: bodyA.message?.content,
    });

    // ── The pinned claim: the acceptance says the line should now persist
    //    at qty 2 / unit hour. Expected to fail against current behavior. ──
    const finalLines = await queryAsTenant(
      tenantA.tenantId,
      `SELECT description, quantity FROM estimate_line_items WHERE estimate_id = $1 AND quantity = 2`,
      [estimateA],
    );
    expect(
      finalLines.length,
      'row 6.5 acceptance: a qty=2 "labor" line should now exist on the Garcia estimate',
    ).toBeGreaterThan(0);
  });

  test('6.6 — "$40 in parts for the Henderson job" never reaches log_expense: no expense is created (genuine, T2), no job.jobId-linked expense ever appears (pinned)', async ({
    request,
  }) => {
    test.setTimeout(180_000);
    test.fail(
      true,
      'intent-classifier.ts has no deterministic short-circuit for `log_expense` (nor its ' +
        '`log_mileage` alias) anywhere in the file. On the real chat surface with no ' +
        'AI_PROVIDER_API_KEY, mock.ts:160-197 classifies this exact utterance as intentType: ' +
        '"unknown" — CHAT_INTENT_TO_REGISTRY_KEY.log_expense (routes/assistant.ts:2170) is real ' +
        'and wired (LogExpenseTaskHandler drafts a real log_expense proposal with jobId + ' +
        'amount), but classify_intent never confidently names it without a live model, so it is ' +
        'never reached from this surface — the truck-as-back-office claim for expenses does ' +
        'not hold on chat today.',
    );

    const tenantA = await bootstrapOwner(request, '66a', 'Copper Line HVAC 6.6');
    const tenantB = await bootstrapOwner(request, '66b', 'Bluebonnet Plumbing 6.6');
    const jobA = await seedJob(request, tenantA, 'Pat', { firstName: 'Pat', lastName: 'Henderson' });
    const jobB = await seedJob(request, tenantB, 'Casey', { firstName: 'Casey', lastName: 'Henderson' });

    const beforeA = await proposalsCount(tenantA.tenantId);
    const bodyA = await chatViaApi(request, tenantA, '$40 in parts for the Henderson job.');
    const afterA = await proposalsCount(tenantA.tenantId);
    expect(afterA).toBe(beforeA); // genuine: nothing was drafted

    const beforeB = await proposalsCount(tenantB.tenantId);
    const bodyB = await chatViaApi(request, tenantB, '$40 in parts for the Henderson job.');
    const afterB = await proposalsCount(tenantB.tenantId);
    expect(afterB).toBe(beforeB); // T2, genuine: neighbour equally unaffected
    expect(JSON.stringify(bodyB.message?.content ?? '')).not.toContain(jobA.jobId);

    logRows('6.6 real chat replies for both tenants (report-only — no log_expense reached)', {
      chatReplyA: bodyA.message?.content,
      chatReplyB: bodyB.message?.content,
    });

    // ── The pinned claim: the acceptance says a real log_expense should
    //    persist, carrying jobId + amount 4000 cents. Expected to fail. ────
    const expenseProposals = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id, payload FROM proposals
         WHERE tenant_id = $1 AND proposal_type = 'log_expense'
           AND payload->>'jobId' = $2`,
      [tenantA.tenantId, jobA.jobId],
    );
    expect(
      expenseProposals.length,
      'row 6.6 acceptance: a $40 log_expense proposal linked to the Henderson job should exist',
    ).toBeGreaterThan(0);
  });

  test('6.9-on-chat — "three-quarter copper, twenty feet for the Henderson job" never reaches add_material via the real chat surface: no material_items row is created (genuine, T2) (pinned)', async ({
    request,
  }) => {
    test.setTimeout(180_000);
    test.fail(
      true,
      'intent-classifier.ts has no deterministic short-circuit for `add_material` anywhere in ' +
        'the file. On the real chat surface with no AI_PROVIDER_API_KEY, mock.ts:160-197 ' +
        'classifies this exact utterance as intentType: "unknown" — ' +
        'CHAT_INTENT_TO_REGISTRY_KEY.add_material (routes/assistant.ts:2188) is real and wired ' +
        '(AddMaterialTaskHandler + the real material_items write, already proven at real ' +
        'Postgres by test/integration/material-items.test.ts, #1019 6.9), but classify_intent ' +
        'never confidently names it without a live model, so it is never reached from the ' +
        'owner\'s real chat surface — the row is proven at the router level (a scripted ' +
        'classifier reply), never end-to-end through POST /api/assistant/chat.',
    );

    const tenantA = await bootstrapOwner(request, '69a', 'Copper Line HVAC 6.9');
    const tenantB = await bootstrapOwner(request, '69b', 'Bluebonnet Plumbing 6.9');
    const jobA = await seedJob(request, tenantA, 'Pat', { firstName: 'Pat', lastName: 'Henderson' });
    const jobB = await seedJob(request, tenantB, 'Casey', { firstName: 'Casey', lastName: 'Henderson' });

    const beforeA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT count(*)::int AS n FROM material_items WHERE tenant_id = $1`,
      [tenantA.tenantId],
    );
    const bodyA = await chatViaApi(
      request,
      tenantA,
      'I need three-quarter copper, twenty feet, for the Henderson job.',
    );
    const afterA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT count(*)::int AS n FROM material_items WHERE tenant_id = $1`,
      [tenantA.tenantId],
    );
    expect(afterA[0].n).toBe(beforeA[0].n); // genuine: nothing was drafted or written

    const beforeB = await queryAsTenant(
      tenantB.tenantId,
      `SELECT count(*)::int AS n FROM material_items WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    await chatViaApi(request, tenantB, 'I need three-quarter copper, twenty feet, for the Henderson job.');
    const afterB = await queryAsTenant(
      tenantB.tenantId,
      `SELECT count(*)::int AS n FROM material_items WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    expect(afterB[0].n).toBe(beforeB[0].n); // T2, genuine: neighbour equally unaffected

    logRows('6.9-on-chat real chat reply (report-only — no add_material reached from chat)', {
      chatReplyA: bodyA.message?.content,
    });

    // ── The pinned claim: quantity=20 / a "copper"+"foot" description should
    //    now round-trip onto a real material_items row. Expected to fail. ──
    const materialRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT description, quantity FROM material_items
         WHERE tenant_id = $1 AND job_id = $2 AND quantity = 20`,
      [tenantA.tenantId, jobA.jobId],
    );
    expect(
      materialRows.length,
      'row 6.9 acceptance: a quantity=20 copper material_items row should exist for the Henderson job',
    ).toBeGreaterThan(0);
  });
});
