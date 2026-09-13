import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_URL,
  bootstrapOwner,
  seedJob,
  seedCatalogItem,
  queryAsTenant,
  queryRaw,
  type Tenant,
} from '../fixtures/estimate-quote-lane';

/**
 * #995 §8.7 Quote — rung-5 reachability, rows 7.1 and 7.3.
 *
 * 7.1 — "As M, I want a quote drafted from the call that already happened,
 * so I'm not re-typing what the customer told the AI." Acceptance: given a
 * spoken description OR a customer photo, when drafted, a real
 * estimate/proposal row persists plus its audit event.
 *
 * 7.3 — "As M, I want doubt shown on the specific line that earned it, so I
 * know where to look." Acceptance: each line carries its own
 * `pricingSource`, an invalid one is refused by a DB CHECK on a raw UPDATE,
 * and a badge renders per line.
 *
 * REAL SURFACE: the owner's Assistant chat (`/assistant`,
 * `packages/web/src/components/assistant/AssistantPage.tsx`), which POSTs
 * to the real `POST /api/assistant/chat` route. The canonical dictated
 * phrasing "draft/create/write/prepare/generate an estimate for <customer>:
 * <line items>" hits `matchDraftEstimatePhrase`
 * (`packages/api/src/ai/orchestration/intent-classifier.ts:1702`), a
 * DETERMINISTIC pre-LLM short-circuit (no gateway call for classification —
 * `context.extendedIntents` is unconditionally true on the chat surface,
 * `intent-classifier.ts:2576`) that dispatches straight to the real
 * `EstimateTaskHandler`. That handler still calls `gateway.complete` to turn
 * the free text into structured line items; with no `AI_PROVIDER_API_KEY`
 * configured (true for every spec in this lane, per the shared preamble)
 * the app boots `createHermeticMockLLMGateway()`
 * (`packages/api/src/ai/gateway/factory.ts:465`), whose `scriptHermeticResponse`
 * (`packages/api/src/ai/providers/mock.ts:243`) is PRODUCTION code — not a
 * test double this spec injects — deterministically scripting one
 * catalog-groundable line item from the message text. This is the
 * documented "spoken description" analog this lane can drive end-to-end
 * with no live model: see the file-level "what is NOT proven" note for why
 * literal browser-simulated speech-to-text is not attempted here, and why
 * the "customer photo" leg is a real product gap, not a reachability limit.
 */

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-7-quote-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function draftViaChat(
  page: import('@playwright/test').Page,
  customerName: string,
  lineText: string,
): Promise<void> {
  await page.goto('/assistant');
  const textarea = page.getByPlaceholder(/Ask anything or give a command/i);
  await expect(textarea).toBeVisible({ timeout: 20_000 });
  await textarea.fill(`Draft an estimate for ${customerName}: ${lineText}`);
  await textarea.press('Enter');
}

test.describe('§8.7 rows 7.1 + 7.3 — quote drafted from what the customer said, doubt shown per line (real Postgres)', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.VITE_CLERK_PUBLISHABLE_KEY;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres (E2E_USE_TEST_DB=true, DATABASE_URL set).',
  );

  test('a dictated draft_estimate persists a real estimate + audit event through the owner Assistant chat; a mixed-pricing draft shows per-line badges and the DB CHECK refuses a bogus pricing_source; a neighbour tenant never sees any of it (T2)', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: the tenant under test ──────────────────────────────────
    const tenantA = await bootstrapOwner(request, 'a', 'Copper Line HVAC 7.1');
    // "Sarah Customer" — seedJob's default lastName is 'Customer', matching
    // the hermetic mock's extractName() picking up "for Sarah Customer:"
    // from the dictated message (ai/providers/mock.ts extractName()).
    await seedJob(request, tenantA, 'Sarah');

    // ── T2 — a wholly independent neighbour tenant, drafts nothing ───────
    const tenantB = await bootstrapOwner(request, 'b', 'Bluebonnet Plumbing 7.1');
    await seedJob(request, tenantB, 'Jordan');

    // Seed a catalog item whose name EXACTLY matches the hermetic mock's
    // scripted line-item description ("Service estimate for Sarah
    // Customer" — scriptHermeticResponse's draft_estimate branch: `${label}
    // for ${extractName(text)}`, label = 'Service estimate' for a taskType
    // that doesn't mention 'invoice') so THIS line grounds as 'catalog'.
    await seedCatalogItem(request, tenantA, {
      name: 'Service estimate for Sarah Customer',
      unitPriceCents: 15_000,
      category: 'Labor',
    });

    // ── 7.1 + 7.3 (catalog leg): draft through the REAL owner browser ────
    await draftViaChat(page, 'Sarah Customer', 'two-hour diagnostic visit');

    const approveBtn = page.getByRole('button', { name: /^Approve$/ }).first();
    await expect(approveBtn).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.1-drafted-proposal-catalog.png') });

    // Per-line pricing-source badge — the 7.3 UI leg. 'catalog' → "From
    // catalog" (AIProposalCard.tsx PRICING_SOURCE_BADGE).
    const catalogBadges = page.locator('[data-testid="pricing-source-badges"]').first();
    await expect(catalogBadges).toBeVisible();
    await expect(catalogBadges.getByText('From catalog')).toBeVisible();

    await approveBtn.click();
    await expect(page.getByText(/Approved/i).first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.1-approved-proposal-catalog.png') });

    // ── Durable proof: a REAL estimates row + estimate.created audit ─────
    // #1133 — poll for the row (the create transaction commits on
    // res.finish, after the response is flushed).
    let estimateRow: Record<string, unknown> | undefined;
    for (let i = 0; i < 20 && !estimateRow; i++) {
      const rows = await queryAsTenant(
        tenantA.tenantId,
        `SELECT e.id, e.tenant_id, e.status
           FROM estimates e
           JOIN customers c ON c.id = e.customer_id
          WHERE e.tenant_id = $1 AND c.first_name = 'Sarah'
          ORDER BY e.created_at DESC LIMIT 1`,
        [tenantA.tenantId],
      );
      estimateRow = rows[0];
      if (!estimateRow) await page.waitForTimeout(100);
    }
    expect(estimateRow, '#1133 workaround: polled for the drafted estimate row').toBeTruthy();
    const estimateId = estimateRow!.id as string;

    const lineRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT description, unit_price_cents, pricing_source
         FROM estimate_line_items WHERE estimate_id = $1`,
      [estimateId],
    );
    expect(lineRows.length).toBeGreaterThanOrEqual(1);
    expect(lineRows[0].pricing_source).toBe('catalog');
    expect(Number(lineRows[0].unit_price_cents)).toBe(15_000);

    const auditRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type FROM audit_events
         WHERE tenant_id = $1 AND entity_type = 'estimate' AND entity_id = $2
           AND event_type = 'estimate.created'`,
      [tenantA.tenantId, estimateId],
    );
    expect(auditRows).toHaveLength(1);

    // ── 7.3 (uncatalogued leg): a SECOND dictated draft with no matching
    //    catalog item shows a DIFFERENT badge ("AI-estimated") — proving
    //    each line's badge tracks ITS OWN pricingSource, not a card-wide
    //    constant. (The hermetic mock always scripts exactly one line per
    //    turn — see the file-level note — so this is a second card, not a
    //    second line on the same card; the same-document multi-line
    //    mixture is already proven at real Postgres by
    //    test/integration/estimates.test.ts's pricing_source suite, T1.) ──
    await seedJob(request, tenantA, 'Priya', { firstName: 'Priya', lastName: 'Vendor' });
    await draftViaChat(page, 'Priya Vendor', 'replace a section of copper line');

    const approveBtn2 = page.getByRole('button', { name: /^Approve$/ }).first();
    await expect(approveBtn2).toBeVisible({ timeout: 20_000 });
    const uncatalogedBadges = page.locator('[data-testid="pricing-source-badges"]').first();
    await expect(uncatalogedBadges).toBeVisible();
    await expect(uncatalogedBadges.getByText('AI-estimated')).toBeVisible();
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.3-uncatalogued-badge.png') });

    await approveBtn2.click();
    await expect(page.getByText(/Approved/i).first()).toBeVisible({ timeout: 20_000 });

    let estimateRow2: Record<string, unknown> | undefined;
    for (let i = 0; i < 20 && !estimateRow2; i++) {
      const rows = await queryAsTenant(
        tenantA.tenantId,
        `SELECT e.id FROM estimates e
           JOIN customers c ON c.id = e.customer_id
          WHERE e.tenant_id = $1 AND c.first_name = 'Priya'
          ORDER BY e.created_at DESC LIMIT 1`,
        [tenantA.tenantId],
      );
      estimateRow2 = rows[0];
      if (!estimateRow2) await page.waitForTimeout(100);
    }
    expect(estimateRow2).toBeTruthy();
    const lineRows2 = await queryAsTenant(
      tenantA.tenantId,
      `SELECT pricing_source FROM estimate_line_items WHERE estimate_id = $1`,
      [estimateRow2!.id],
    );
    expect(lineRows2[0].pricing_source).toBe('uncatalogued');

    // ── 7.3: the DB CHECK refuses an invalid pricing_source on a raw
    //    UPDATE (estimate_line_items_pricing_source_check, migration
    //    179_estimate_line_items_pricing_source, schema.ts:4506). This is
    //    a genuine constraint probe, not a product path — a raw UPDATE is
    //    the only way to observe a DB CHECK firing. ─────────────────────
    const lineIdRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id FROM estimate_line_items WHERE estimate_id = $1 LIMIT 1`,
      [estimateId],
    );
    const lineId = lineIdRows[0].id as string;
    const badUpdate = await queryRaw(
      `UPDATE estimate_line_items SET pricing_source = 'bogus' WHERE id = $1`,
      [lineId],
    );
    expect(badUpdate.error, 'the DB CHECK must reject an invalid pricing_source').toBeTruthy();
    expect(String(badUpdate.error?.message)).toMatch(/pricing_source/i);

    // ── T2 — tenant B never sees tenant A's drafted estimates ────────────
    const bRows = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM estimates WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    expect(bRows).toHaveLength(0);
    const crossRead = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM estimates WHERE id = $1`,
      [estimateId],
    );
    expect(crossRead).toHaveLength(0);

    expect(pageErrors, 'no uncaught page errors during the drafting journey').toEqual([]);
  });

  // ── 7.1 — product gap, pinned rather than faked ─────────────────────────
  test('the "customer photo" leg has NO owner-facing transmission path — pinned, not faked', async () => {
    // AssistantPage.tsx's `send()` accepts `opts.attachments` and renders
    // them in the LOCAL chat-bubble state (AssistantPage.tsx:919
    // `attachments: opts?.attachments`), but `sendToConversationAPI`
    // (AssistantPage.tsx:69-90) POSTs only `{ messages, conversationId,
    // inputMode }` to `/api/assistant/chat` — the attachment's bytes/URL
    // are NEVER included in that body. A customer photo attached through
    // the owner's real Assistant UI is therefore never seen by the
    // backend, `EstimateTaskHandler`, or any vision task — it cannot draft
    // anything. The ONLY vision-drafting path in the codebase is the
    // CUSTOMER-initiated MMS surface (`sms/customer-mms/customer-mms-intake.ts`,
    // dispatched from `workers/mms-ingest-worker.ts`, a background worker —
    // not the synchronous webhook request), a different persona/channel
    // from "M" reviewing a call/photo in the Assistant, and out of scope
    // for a browser-driven owner spec. Filed here rather than silently
    // worked around.
    test.fail(
      true,
      'AssistantPage.tsx:1052 + sendToConversationAPI (AssistantPage.tsx:69-90): the "photo" ' +
        'input mode captures an attachment in local UI state but never transmits it to ' +
        'POST /api/assistant/chat — no owner-facing draft-from-photo path exists to reach.',
    );
  });
});
