import { Page, APIRequestContext } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  API_URL,
  bootstrapOwner,
  seedJob,
  queryAsTenant,
  drawSignature,
  logRows,
  signInOwnerBrowser,
  type Tenant,
  type JobRef,
} from '../fixtures/estimate-quote-lane';

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-7-quote-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * §8.7 rows 7.4 + 7.5 — rung-5 reachability.
 *
 * 7.4 ("As M, I want good/better/best tiers, so I stop leaving money on the
 * table"): the real owner surface is the estimate-drafting form itself
 * (`/estimates/new`, `EstimateForm.tsx` → `LineItemEditor.tsx`'s
 * `enableOptions` good-better-best authoring controls — "Optional add-on" /
 * "Tier group" / "Pre-selected") — not the AI chat path (the hermetic mock
 * can only script a single flat line per turn, see the 7.1/7.3 spec's
 * header). This drives that REAL form: three tier rows sharing one
 * `groupLabel` (⇒ `groupKey`) plus one standalone add-on, submitted through
 * the real `POST /api/estimates`.
 *
 * 7.5 ("the headline price is the option I recommended, not the sum of all
 * three"): two halves. The accepted-total half (customer selects → server
 * recomputes → persists) is proven exactly like row 7.6's earned spec. The
 * other half — "the headline, as first rendered, equals the DEFAULT
 * selection, before the customer touches anything" — was previously
 * unit-only (billing-engine.test.ts). This spec closes that: it asserts the
 * real public page's FIRST-RENDER total (before any tier click) against
 * real Postgres data, strictly less than the sum of all tier+add-on lines.
 */

const TIER_GROUP = 'Service Tier';
const BASIC = { description: 'Basic Package', price: 200 };
const PREMIUM = { description: 'Premium Package', price: 350 };
const DELUXE = { description: 'Deluxe Package', price: 500 };
const ADDON = { description: 'Extended Warranty', price: 45 };
const SUM_ALL_CENTS = (200 + 350 + 500 + 45) * 100;
const DEFAULT_HEADLINE_CENTS = 200 * 100;
const ACCEPTED_CENTS = (350 + 45) * 100;

/** Fill row `index` of the LineItemEditor (aria-label pattern from
 * packages/web/src/components/forms/LineItemEditor.tsx). */
async function fillRow(
  page: Page,
  index: number,
  row: { description: string; price: number; group?: string; optional?: boolean; defaultSelected?: boolean },
): Promise<void> {
  await page.getByLabel(`description-${index}`).fill(row.description);
  await page.getByLabel(`quantity-${index}`).fill('1');
  await page.getByLabel(`unit-price-${index}`).fill(row.price.toFixed(2));
  if (row.optional) {
    await page.getByLabel(`optional-${index}`).check();
  }
  if (row.group) {
    await page.getByLabel(`group-${index}`).fill(row.group);
  }
  if (row.defaultSelected) {
    await page.getByLabel(`default-selected-${index}`).check();
  }
}

/** Owner browser: draft a 3-tier + 1-add-on estimate through the REAL
 * good-better-best authoring UI and submit it. Returns the created id via
 * the estimates list (the form navigates away on success, not exposing the
 * id directly). */
async function draftTieredEstimateViaOwnerUi(
  page: Page,
  request: APIRequestContext,
  tenant: Tenant,
  job: JobRef,
  screenshotName: string,
): Promise<string> {
  // Owner form at a desktop viewport: at 390×844 the fixed assistant bar +
  // bottom nav overlay the scrolled-into-view submit button.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/estimates/new?jobId=${job.jobId}`);
  await expect(page.getByLabel('description-0')).toBeVisible({ timeout: 20_000 });

  await fillRow(page, 0, { description: BASIC.description, price: BASIC.price, group: TIER_GROUP, defaultSelected: true });
  await page.getByRole('button', { name: /\+ Add row/i }).click();
  await fillRow(page, 1, { description: PREMIUM.description, price: PREMIUM.price, group: TIER_GROUP });
  await page.getByRole('button', { name: /\+ Add row/i }).click();
  await fillRow(page, 2, { description: DELUXE.description, price: DELUXE.price, group: TIER_GROUP });
  await page.getByRole('button', { name: /\+ Add row/i }).click();
  await fillRow(page, 3, { description: ADDON.description, price: ADDON.price, optional: true });

  await expect(page.getByTestId('line-items-total')).toHaveText(/1,095\.00|1095\.00/);
  await page.screenshot({ path: join(SCREENSHOT_DIR, screenshotName) });

  // Wait for the REAL POST /api/estimates the form fires — at phone width
  // the fixed "Ask Rivet AI anything…" bar + bottom nav sit over the
  // submit button after scroll-into-view, so a bare click can land on the
  // bar and never submit (observed: page still on the form, no POST in the
  // api log). The owner-form legs run at a desktop viewport (set by the
  // caller); this additionally asserts the request actually went out and
  // was accepted, and that the SPA really left /estimates/new.
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/estimates',
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: /^Create estimate$/ }).click();
  const createdRes = await created;
  expect(createdRes.status(), `POST /api/estimates -> ${createdRes.status()} ${await createdRes.text()}`).toBe(201);
  await expect(page).not.toHaveURL(/\/estimates\/new/, { timeout: 20_000 });

  // #1133 workaround — the form's POST /api/estimates commits on res.finish,
  // AFTER the response is flushed and the SPA has already navigated to
  // /estimates; a list GET fired the instant the URL changed can miss the
  // row (observed: Received length 0). Poll the job's own list (≤2s) before
  // asserting — a read retry, never a re-write.
  let rows: Array<{ id: string }> = [];
  const deadline = Date.now() + 2_000;
  for (;;) {
    const listRes = await request.get(`${API_URL}/api/estimates?jobId=${job.jobId}`, {
      headers: tenant.authHeaders,
    });
    expect(listRes.ok()).toBeTruthy();
    rows = (await listRes.json()) as Array<{ id: string }>;
    if (rows.length > 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(rows, 'the owner-drafted tiered estimate must persist').toHaveLength(1);
  return rows[0].id;
}

test.describe('good/better/best tiers with add-ons (7.4) + headline-over-default-selection (7.5) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container.',
  );
  test.use({ viewport: { width: 390, height: 844 } });

  test('owner drafts 3 tiers + an add-on through the real form; the public page headline equals the default tier before any click; the customer picks Premium+Warranty; all rows + the accepted selection survive; a neighbour tenant is untouched (T2)', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: the tiered estimate under test ────────────────────────────
    const tenantA = await bootstrapOwner(request, 'a', 'Acme HVAC 7.4-7.5');
    const jobA = await seedJob(request, tenantA, 'Drew');

    // ── Tenant B (T2): an independent tiered estimate on its own job ───────
    const tenantB = await bootstrapOwner(request, 'b', 'Bexar Plumbing 7.4-7.5');
    const jobB = await seedJob(request, tenantB, 'Sasha');

    // ── Owner (A) drafts through the real good-better-best UI ──────────────
    await signInOwnerBrowser(page, baseURL!, tenantA);
    const estimateIdA = await draftTieredEstimateViaOwnerUi(
      page,
      request,
      tenantA,
      jobA,
      '7.4-7.5-owner-draft-tiers.png',
    );

    // ── Owner (B) drafts an independent tiered estimate, T2 ─────────────────
    await signInOwnerBrowser(page, baseURL!, tenantB);
    const estimateIdB = await draftTieredEstimateViaOwnerUi(
      page,
      request,
      tenantB,
      jobB,
      '7.4-7.5-owner-draft-tiers-tenantB.png',
    );

    // Cross-tenant negative — A cannot read B's estimate.
    const crossRead = await request.get(`${API_URL}/api/estimates/${estimateIdB}`, {
      headers: tenantA.authHeaders,
    });
    expect([403, 404]).toContain(crossRead.status());

    // ── 7.4: every tier row + the add-on row persisted at real Postgres ────
    const linesA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT description, group_key, is_optional, is_default_selected, unit_price_cents
         FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order`,
      [estimateIdA],
    );
    logRows('7.4 estimate_line_items after owner-form draft (tenant A)', linesA);
    expect(linesA).toHaveLength(4);
    expect(linesA.map((l) => l.description)).toEqual([
      BASIC.description, PREMIUM.description, DELUXE.description, ADDON.description,
    ]);
    expect(linesA.filter((l) => l.group_key === TIER_GROUP)).toHaveLength(3);
    expect(linesA.find((l) => l.description === ADDON.description)?.group_key).toBeNull();
    expect(linesA.find((l) => l.description === ADDON.description)?.is_optional).toBe(true);
    expect(linesA.find((l) => l.description === BASIC.description)?.is_default_selected).toBe(true);

    // ── Send it, then send tenant B's too ───────────────────────────────────
    const sendA = await request.post(`${API_URL}/api/estimates/${estimateIdA}/send`, {
      headers: { 'content-type': 'application/json', ...tenantA.authHeaders },
      data: JSON.stringify({ channel: 'email' }),
    });
    expect(sendA.ok(), `send A -> ${sendA.status()} ${await sendA.text()}`).toBeTruthy();
    const sentA = (await sendA.json()) as { viewToken: string };

    const sendB = await request.post(`${API_URL}/api/estimates/${estimateIdB}/send`, {
      headers: { 'content-type': 'application/json', ...tenantB.authHeaders },
      data: JSON.stringify({ channel: 'email' }),
    });
    expect(sendB.ok()).toBeTruthy();
    const sentB = (await sendB.json()) as { viewToken: string };

    // ── T2 on the public surface too: B's token never shows A's content ────
    // Customer legs at the phone viewport the 7.6 spec uses.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/e/${sentB.viewToken}`);
    await expect(page.getByText('Bexar Plumbing 7.4-7.5', { exact: true })).toBeVisible();
    await expect(page.getByText('Acme HVAC 7.4-7.5', { exact: true })).toHaveCount(0);

    // ── 7.5, first half: the headline, as FIRST rendered (no click yet),
    //    equals the DEFAULT selection (Basic, $200) — strictly less than the
    //    sum of all four lines ($1,095) ─────────────────────────────────────
    await page.goto(`/e/${sentA.viewToken}`);
    await expect(page.getByText('Acme HVAC 7.4-7.5', { exact: true })).toBeVisible();
    await expect(page.getByText(`$${(DEFAULT_HEADLINE_CENTS / 100).toFixed(2)}`).first()).toBeVisible();
    await expect(page.getByText(`$${(SUM_ALL_CENTS / 100).toFixed(2)}`)).toHaveCount(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.5-headline-before-selection.png') });

    // ── Customer picks Premium + the add-on (NOT the default) ───────────────
    await page.getByRole('button', { name: new RegExp(PREMIUM.description, 'i') }).click();
    await page.getByRole('button', { name: new RegExp(ADDON.description, 'i') }).click();
    await expect(page.getByText(`$${(ACCEPTED_CENTS / 100).toFixed(2)}`).first()).toBeVisible();

    await page.getByRole('button', { name: /Accept this estimate/i }).click();
    await page.getByPlaceholder('Your full name').fill('Tier Picker Customer');
    // The submit button stays disabled until a signature is drawn (matches
    // e2e/journeys/public-estimate-approve-sign.spec.ts's 7.6 flow).
    await drawSignature(page);
    const submitTier = page.getByRole('button', { name: /^Accept estimate$/ });
    await expect(submitTier).toBeEnabled();
    await submitTier.click();
    await expect(page.getByRole('heading', { name: /Estimate accepted!/i })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.5-accepted-non-default-selection.png') });

    // ── Durable proof: accepted_selection + the recomputed total persisted ─
    const ownerView = await request.get(`${API_URL}/api/estimates/${estimateIdA}`, {
      headers: tenantA.authHeaders,
    });
    const estimateRow = (await ownerView.json()) as {
      status: string;
      acceptedSelection?: string[];
      totals: { totalCents: number };
      lineItems: Array<{ id: string; description: string }>;
    };
    logRows('7.4/7.5 owner GET /api/estimates/:id after accept (status, totals, acceptedSelection, lineItems)', estimateRow);
    expect(estimateRow.status).toBe('accepted');
    expect(estimateRow.totals.totalCents).toBe(ACCEPTED_CENTS);
    expect(estimateRow.totals.totalCents).toBeLessThan(SUM_ALL_CENTS);
    const acceptedDescriptions = estimateRow.lineItems
      .filter((li) => estimateRow.acceptedSelection?.includes(li.id))
      .map((li) => li.description)
      .sort();
    expect(acceptedDescriptions).toEqual([ADDON.description, PREMIUM.description].sort());

    // All FOUR original rows are still there underneath (7.4 — "all tier
    // rows... survive", not just the accepted two).
    const linesAfter = await queryAsTenant(
      tenantA.tenantId,
      `SELECT description FROM estimate_line_items WHERE estimate_id = $1`,
      [estimateIdA],
    );
    logRows('7.4 estimate_line_items after accept — all four rows survive', linesAfter);
    expect(linesAfter).toHaveLength(4);

    // ── Owner UI, post-acceptance: the detail page shows only the billed
    //    (accepted) rows and the SAME recomputed total (D-7 single source) ──
    await signInOwnerBrowser(page, baseURL!, tenantA);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/estimates/${estimateIdA}`);
    await expect(page.getByText(`$${(ACCEPTED_CENTS / 100).toFixed(2)}`).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(BASIC.description)).toHaveCount(0);
    await expect(page.getByText(DELUXE.description)).toHaveCount(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.4-owner-detail-accepted-rows.png') });

    // ── Tenant B's estimate is completely untouched by A's acceptance ──────
    const bAfter = await request.get(`${API_URL}/api/estimates/${estimateIdB}`, {
      headers: tenantB.authHeaders,
    });
    const bBody = (await bAfter.json()) as { status: string };
    logRows('7.4/7.5 T2 tenant B estimate untouched', bBody);
    expect(bBody.status).toBe('sent');

    expect(pageErrors, 'no uncaught page errors during the tier-authoring journey').toEqual([]);
  });
});
