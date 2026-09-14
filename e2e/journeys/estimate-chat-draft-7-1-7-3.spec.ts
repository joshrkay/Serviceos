import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import {
  API_URL,
  WELCOME_SEEN_KEY,
  WHATS_NEW_SEEN_KEY,
  bootstrapOwner,
  seedJob,
  seedCatalogItem,
  queryAsTenant,
  queryRaw,
  logRows,
  type Tenant,
} from '../fixtures/estimate-quote-lane';

/**
 * Sign the REAL browser in as this bootstrapped owner — the same recipe
 * e2e/journeys/digest-toggle.spec.ts and dispatch-board.spec.ts use
 * (installClerkStub + the two walkthrough-seen localStorage keys so no
 * overlay intercepts a click + blockExternalHosts), before the first goto.
 */
async function signInBrowser(page: Page, baseURL: string, tenant: Tenant): Promise<void> {
  await installClerkStub(page, { signedIn: true, sub: tenant.sub, token: tenant.jwt });
  await page.addInitScript(
    ({ welcomeKey, whatsNewKey }) => {
      try {
        localStorage.setItem(welcomeKey, '1');
        localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
      } catch {
        /* storage unavailable — overlays may show; the assertions still hold */
      }
    },
    { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
  );
  await blockExternalHosts(page, baseURL);
}

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
 * literal browser-simulated speech-to-text is not attempted here. The
 * "customer photo" leg (last test) was a pinned product gap until #1144
 * (upload + attachments contract) and #1173 (the photo reaches the draft as
 * an image part).
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
  await expect(textarea).toBeVisible({ timeout: 90_000 });
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
    baseURL,
  }) => {
    // Two real chat turns: with three lanes' stacks on one Mac the first
    // POST /api/assistant/chat took 14s and the second had not completed
    // inside a 20s wait (run 1) — the drafting pipeline (intent
    // short-circuit → EstimateTaskHandler → catalog resolver → proposal +
    // conversation persistence) is the bottleneck, not the DOM.
    test.setTimeout(360_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: the tenant under test ──────────────────────────────────
    const tenantA = await bootstrapOwner(request, 'a', 'Copper Line HVAC 7.1');
    // The owner's REAL browser session — signed in as this exact owner.
    await signInBrowser(page, baseURL!, tenantA);
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
    await expect(approveBtn).toBeVisible({ timeout: 90_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.1-drafted-proposal-catalog.png') });

    // Per-line pricing-source badge — the 7.3 UI leg. 'catalog' → "From
    // catalog" (AIProposalCard.tsx PRICING_SOURCE_BADGE).
    const catalogBadges = page.locator('[data-testid="pricing-source-badges"]').first();
    await expect(catalogBadges).toBeVisible();
    await expect(catalogBadges.getByText('From catalog')).toBeVisible();

    await approveBtn.click();
    await expect(page.getByText(/Approved/i).first()).toBeVisible({ timeout: 90_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.1-approved-proposal-catalog.png') });

    // ── Durable proof: a REAL estimates row + estimate.created audit ─────
    // #1133 — poll for the row (the create transaction commits on
    // res.finish, after the response is flushed).
    let estimateRow: Record<string, unknown> | undefined;
    // #1133 — up to 10s: under three lanes' load a fresh row has 404'd for
    // >2s (7.10 run 2, seven consecutive misses); a read retry, never a re-write.
    for (let i = 0; i < 100 && !estimateRow; i++) {
      const rows = await queryAsTenant(
        tenantA.tenantId,
        `SELECT e.id, e.tenant_id, e.status
           FROM estimates e
           JOIN jobs j ON j.id = e.job_id
           JOIN customers c ON c.id = j.customer_id
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
    logRows('7.1 drafted estimates row (chat → hermetic gateway → EstimateTaskHandler → Approve → execute)', estimateRow);
    logRows('7.1/7.3 estimate_line_items (catalog-grounded line: description, unit_price_cents, pricing_source)', lineRows);
    expect(lineRows[0].pricing_source).toBe('catalog');
    expect(Number(lineRows[0].unit_price_cents)).toBe(15_000);

    const auditRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type FROM audit_events
         WHERE tenant_id = $1 AND entity_type = 'estimate' AND entity_id = $2
           AND event_type = 'estimate.created'`,
      [tenantA.tenantId, estimateId],
    );
    logRows('7.1 audit_events estimate.created for the drafted estimate', auditRows);
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
    await expect(approveBtn2).toBeVisible({ timeout: 90_000 });
    const uncatalogedBadges = page.locator('[data-testid="pricing-source-badges"]').first();
    await expect(uncatalogedBadges).toBeVisible();
    await expect(uncatalogedBadges.getByText('AI-estimated')).toBeVisible();
    // The doubt is named on the line itself, not card-wide.
    await expect(
      page.getByText(/"Service estimate for Priya Vendor" is not in the tenant catalog/i).first(),
    ).toBeVisible();
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.3-uncatalogued-badge.png') });

    // ── 7.2 on the real surface (report-only row, observed here for free):
    //    the uncatalogued line caps confidence below the auto-approve floor
    //    and the card's Approve is DISABLED until the operator resolves it —
    //    the product refuses the one-tap approve. Run 2 of this spec tried
    //    to click it and timed out on `disabled`; that is the product being
    //    right. So: no second estimate row is expected — the durable proof
    //    for THIS leg is the proposal row itself. ────────────────────────
    await expect(approveBtn2).toBeDisabled();

    let proposalRow: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !proposalRow; i++) {
      const rows = await queryAsTenant(
        tenantA.tenantId,
        `SELECT id, status, confidence_score,
                payload->'lineItems'->0->>'description'   AS line_description,
                payload->'lineItems'->0->>'pricingSource' AS line_pricing_source,
                payload->'_meta'->>'overallConfidence'    AS overall_confidence
           FROM proposals
          WHERE tenant_id = $1 AND proposal_type = 'draft_estimate'
            AND payload->'lineItems'->0->>'description' LIKE '%Priya Vendor%'
          ORDER BY created_at DESC LIMIT 1`,
        [tenantA.tenantId],
      );
      proposalRow = rows[0];
      if (!proposalRow) await page.waitForTimeout(100);
    }
    logRows('7.3 uncatalogued draft — proposals row (line pricingSource, capped confidence, NOT approved)', proposalRow);
    expect(proposalRow, 'the uncatalogued draft persisted as a proposal').toBeTruthy();
    expect(proposalRow!.line_pricing_source).toBe('uncatalogued');
    expect(proposalRow!.status).not.toBe('approved');
    // Cap: strictly below the 0.9 auto-approve floor (catalog-resolver.ts).
    expect(Number(proposalRow!.confidence_score)).toBeLessThan(0.9);

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
    logRows('7.3 raw UPDATE estimate_line_items SET pricing_source = bogus — Postgres refusal', {
      code: badUpdate.error?.code,
      message: badUpdate.error?.message,
    });
    expect(badUpdate.error, 'the DB CHECK must reject an invalid pricing_source').toBeTruthy();
    expect(String(badUpdate.error?.message)).toMatch(/pricing_source/i);

    // ── T2 — tenant B never sees tenant A's drafted estimates ────────────
    const bRows = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM estimates WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    expect(bRows).toHaveLength(0);
    // The cross-tenant probe goes through the REAL API, not raw SQL: the
    // Playwright harness connects as the testcontainer's superuser (no
    // RLS_RUNTIME_ROLE / SET ROLE rls_app_runtime here), and superusers
    // bypass RLS even under FORCE ROW LEVEL SECURITY (schema.ts:545-548) —
    // run 3 read tenant A's row "as" tenant B that way. The product's
    // isolation on this surface is what tenant B's owner actually gets.
    const crossRead = await request.get(`${API_URL}/api/estimates/${estimateId}`, {
      headers: tenantB.authHeaders,
    });
    expect([403, 404]).toContain(crossRead.status());
    const bList = await request.get(`${API_URL}/api/estimates`, { headers: tenantB.authHeaders });
    expect(bList.ok()).toBeTruthy();
    const bListBody = (await bList.json()) as unknown;
    const bItems = Array.isArray(bListBody) ? bListBody : ((bListBody as { data?: unknown[] }).data ?? []);
    logRows('7.1/7.3 T2 — tenant B GET /api/estimates (sees none of A)', { crossReadStatus: crossRead.status(), bItems });
    expect(bItems).toHaveLength(0);

    expect(pageErrors, 'no uncaught page errors during the drafting journey').toEqual([]);
  });

  // ── 7.1 — the "customer photo" leg (flipped by #1173, on top of #1144) ───
  test('the "customer photo" leg: a photo uploaded through the files route and carried on the Assistant turn drafts a real estimate proposal from the photo; a neighbour tenant\'s photo is refused (T2)', async ({
    request,
  }) => {
    test.setTimeout(180_000);
    // The wire sequence AssistantPage.tsx's photo picker produces (#1144,
    // createSignedPhotoUpload → send): POST /api/files/upload-url → PUT the
    // bytes to the returned URL → POST /api/assistant/chat carrying
    // `attachments: [{ fileId }]` with the page's own photo prompt. The
    // file-picker DOM half is pinned by #1144's AssistantPage.test.tsx; this
    // leg drives the real API routes at real Postgres.
    //
    // The chat route resolves the fileId TENANT-SCOPED (files repo) and
    // presigns it; EstimateTaskHandler sends it to the gateway as an image
    // part. With no AI_PROVIDER_API_KEY the app boots
    // createHermeticMockLLMGateway(), whose PRODUCTION `scriptHermeticResponse`
    // scripts a DISTINCT line ("Repair shown in photo") only when the
    // draft_estimate request actually carries an image part — so that line on
    // the persisted proposal is the hermetic proof the photo reached the model.
    const PHOTO_PROMPT = "Here's the photo — can you identify the issue?";
    // A 1x1 JPEG — real image bytes, not a placeholder.
    const JPEG = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
      'base64',
    );

    async function uploadPhoto(tenant: Tenant, filename: string): Promise<string> {
      const presign = await request.post(`${API_URL}/api/files/upload-url`, {
        headers: { 'content-type': 'application/json', ...tenant.authHeaders },
        data: JSON.stringify({
          filename,
          contentType: 'image/jpeg',
          sizeBytes: JPEG.length,
          entityType: 'assistant_chat_photo',
        }),
      });
      expect(presign.ok(), `files/upload-url -> ${presign.status()} ${await presign.text()}`).toBeTruthy();
      const { fileId, uploadUrl } = (await presign.json()) as { fileId: string; uploadUrl: string };
      const put = await request.put(uploadUrl, { headers: { 'content-type': 'image/jpeg' }, data: JPEG });
      expect(put.ok(), `PUT ${uploadUrl} -> ${put.status()}`).toBeTruthy();
      return fileId;
    }

    async function photoTurn(tenant: Tenant, fileId: string) {
      const res = await request.post(`${API_URL}/api/assistant/chat`, {
        headers: { 'content-type': 'application/json', ...tenant.authHeaders },
        data: JSON.stringify({
          messages: [{ role: 'user', content: PHOTO_PROMPT }],
          attachments: [{ fileId }],
        }),
        timeout: 90_000,
      });
      expect(res.ok(), `assistant/chat -> ${res.status()} ${await res.text()}`).toBeTruthy();
      return (await res.json()) as { message?: { content?: string; proposal?: { id?: string } } };
    }

    const tenant = await bootstrapOwner(request, 'photo', 'Copper Line HVAC 7.1 Photo');
    const neighbour = await bootstrapOwner(request, 'photob', 'Bluebonnet Plumbing 7.1 Photo');

    const fileId = await uploadPhoto(tenant, 'leak-under-sink.jpg');
    const neighbourFileId = await uploadPhoto(neighbour, 'neighbour-water-heater.jpg');

    // ── The photo turn drafts a proposal ────────────────────────────────
    const body = await photoTurn(tenant, fileId);
    expect(body.message?.proposal, 'a customer photo should yield a drafted proposal').toBeTruthy();

    // #1133 — poll for the row (the request transaction commits on res.finish).
    let proposalRow: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !proposalRow; i++) {
      const rows = await queryAsTenant(
        tenant.tenantId,
        `SELECT id, proposal_type, status,
                payload->'lineItems'->0->>'description' AS line_description,
                source_context->'photoFileIds'           AS photo_file_ids
           FROM proposals
          WHERE tenant_id = $1 AND proposal_type = 'draft_estimate'
          ORDER BY created_at DESC LIMIT 1`,
        [tenant.tenantId],
      );
      proposalRow = rows[0];
      if (!proposalRow) await new Promise((r) => setTimeout(r, 100));
    }
    logRows('7.1 photo leg — proposals row drafted from the uploaded photo', proposalRow);
    expect(proposalRow, '#1133 workaround: polled for the photo-drafted proposal').toBeTruthy();
    expect(proposalRow!.line_description).toBe('Repair shown in photo');
    expect(proposalRow!.photo_file_ids).toEqual([fileId]);
    expect(proposalRow!.status).not.toBe('approved');

    let auditRows: Record<string, unknown>[] = [];
    for (let i = 0; i < 100 && auditRows.length === 0; i++) {
      auditRows = await queryAsTenant(
        tenant.tenantId,
        `SELECT event_type, entity_type, entity_id, metadata
           FROM audit_events
          WHERE tenant_id = $1 AND event_type = 'assistant.photo_estimate_drafted' AND entity_id = $2`,
        [tenant.tenantId, proposalRow!.id],
      );
      if (auditRows.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    logRows('7.1 photo leg — audit_events assistant.photo_estimate_drafted', auditRows);
    expect(auditRows).toHaveLength(1);

    // ── T2 — tenant A naming the neighbour's fileId is refused ───────────
    const draftsBefore = await queryAsTenant(
      tenant.tenantId,
      `SELECT id FROM proposals WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    const crossTurn = await photoTurn(tenant, neighbourFileId);
    logRows('7.1 photo leg T2 — tenant A chat naming tenant B fileId', crossTurn.message);
    expect(crossTurn.message?.proposal).toBeFalsy();
    expect(String(crossTurn.message?.content)).toMatch(/couldn.t open that photo/i);
    const draftsAfter = await queryAsTenant(
      tenant.tenantId,
      `SELECT id FROM proposals WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(draftsAfter).toHaveLength(draftsBefore.length);
    const neighbourProposals = await queryAsTenant(
      neighbour.tenantId,
      `SELECT id FROM proposals WHERE tenant_id = $1`,
      [neighbour.tenantId],
    );
    expect(neighbourProposals).toHaveLength(0);
    // …and tenant B's own photo is still readable to tenant B only.
    const neighbourFile = await request.get(`${API_URL}/api/files/${neighbourFileId}`, {
      headers: neighbour.authHeaders,
    });
    expect(neighbourFile.ok()).toBeTruthy();
    const crossFile = await request.get(`${API_URL}/api/files/${neighbourFileId}`, {
      headers: tenant.authHeaders,
    });
    expect([403, 404]).toContain(crossFile.status());
  });
});
