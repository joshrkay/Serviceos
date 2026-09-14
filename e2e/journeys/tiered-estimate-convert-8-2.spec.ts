import { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  API_URL,
  bootstrapOwner,
  seedCustomerJob,
  queryAsTenant,
  Tenant,
} from '../fixtures/money-lane-8-8';

/**
 * 8.2 — rung-5 reachability: "the invoice bills EXACTLY the tier the
 * customer chose, so I don't bill for options they declined".
 *
 * e2e/journeys/public-estimate-approve-sign.spec.ts (7.6) already drives
 * the full public tier-pick -> sign -> approve -> convert-to-invoice loop
 * through the real browser + real API and asserts the converted invoice's
 * TOTAL. It stops there. 8.2's own acceptance is stricter than a total —
 * "the invoice LINES equal accepted_selection ONLY" — so this spec adds
 * the one assertion 7.6 never made: reading back `invoice_line_items` and
 * proving the DECLINED tiers (and a declined add-on) are absent AS ROWS,
 * not just netted out of the total. Two tenants each pick a DIFFERENT
 * tier in the SAME run (T2), mirroring PR #1053's
 * `integration/tier-billed-exactly.test.ts` (T1) at the real browser
 * surface instead of in-process.
 */

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-8-bill-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface JobRef {
  customerId: string;
  jobId: string;
}

interface SentEstimate {
  estimateId: string;
  viewToken: string;
}

/** Good / Better / Best tiers + one declinable add-on. */
async function createAndSendGoodBetterBestEstimate(
  request: import('@playwright/test').APIRequestContext,
  tenant: Tenant,
  job: JobRef,
): Promise<SentEstimate> {
  const estimateRes = await request.post(`${API_URL}/api/estimates`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      jobId: job.jobId,
      lineItems: [
        {
          id: randomUUID(), description: 'Good Package', quantity: 1,
          unitPriceCents: 15_000, totalCents: 15_000, sortOrder: 0, taxable: false,
          groupKey: 'tier', groupLabel: 'Service Tier', isOptional: true, isDefaultSelected: true,
        },
        {
          id: randomUUID(), description: 'Better Package', quantity: 1,
          unitPriceCents: 25_000, totalCents: 25_000, sortOrder: 1, taxable: false,
          groupKey: 'tier', groupLabel: 'Service Tier', isOptional: true, isDefaultSelected: false,
        },
        {
          id: randomUUID(), description: 'Best Package', quantity: 1,
          unitPriceCents: 32_500, totalCents: 32_500, sortOrder: 2, taxable: false,
          groupKey: 'tier', groupLabel: 'Service Tier', isOptional: true, isDefaultSelected: false,
        },
        {
          id: randomUUID(), description: 'Extended Warranty (add-on)', quantity: 1,
          unitPriceCents: 4_900, totalCents: 4_900, sortOrder: 3, taxable: false,
          isOptional: true, isDefaultSelected: false,
        },
      ],
      customerMessage: 'Pick the package that works for you.',
    }),
  });
  expect(estimateRes.ok(), `create estimate -> ${estimateRes.status()} ${await estimateRes.text()}`).toBeTruthy();
  const estimate = (await estimateRes.json()) as { id: string };

  const sendRes = await request.post(`${API_URL}/api/estimates/${estimate.id}/send`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({ channel: 'email' }),
  });
  expect(sendRes.ok(), `send estimate -> ${sendRes.status()} ${await sendRes.text()}`).toBeTruthy();
  const sent = (await sendRes.json()) as { viewToken: string };
  return { estimateId: estimate.id, viewToken: sent.viewToken };
}

/** Same drag-free signature helper as public-estimate-approve-sign.spec.ts. */
async function drawSignature(page: Page): Promise<void> {
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  let box = await canvas.boundingBox();
  for (let i = 0; i < 40 && box; i++) {
    await page.waitForTimeout(50);
    const next = await canvas.boundingBox();
    if (next && box.x === next.x && box.y === next.y && box.width === next.width) {
      box = next;
      break;
    }
    box = next;
  }
  expect(box).not.toBeNull();
  const points = [
    { x: box!.x + box!.width * 0.2, y: box!.y + box!.height * 0.5 },
    { x: box!.x + box!.width * 0.35, y: box!.y + box!.height * 0.35 },
    { x: box!.x + box!.width * 0.5, y: box!.y + box!.height * 0.65 },
    { x: box!.x + box!.width * 0.65, y: box!.y + box!.height * 0.4 },
  ];
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /^Clear$/i })).toBeVisible({ timeout: 5_000 });
}

async function pickSignAndApprove(
  page: Page,
  viewToken: string,
  tierName: string,
  signerName: string,
  screenshotName?: string,
) {
  await page.goto(`/e/${viewToken}`);
  await page.getByRole('button', { name: new RegExp(tierName, 'i') }).click();
  if (screenshotName) {
    await page.screenshot({ path: join(SCREENSHOT_DIR, `${screenshotName}-tier-picked.png`) });
  }
  await page.getByRole('button', { name: /Accept this estimate/i }).click();
  const nameInput = page.getByPlaceholder('Your full name');
  await expect(nameInput).toBeVisible();
  await nameInput.fill(signerName);
  await drawSignature(page);
  const submit = page.getByRole('button', { name: /^Accept estimate$/ });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('heading', { name: /Estimate accepted!/i })).toBeVisible({ timeout: 15_000 });
  if (screenshotName) {
    await page.screenshot({ path: join(SCREENSHOT_DIR, `${screenshotName}-accepted.png`) });
  }
}

test.describe('the invoice bills exactly the tier chosen (8.2) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with ' +
      'DATABASE_URL pointing at the test container.',
  );
  test.use({ viewport: { width: 390, height: 844 } });

  test('tenant A picks Best (no add-on) and tenant B picks Good in the SAME run; each converted invoice contains ONLY the chosen tier line — the declined tiers and add-on are absent as ROWS, not merely netted out of the total', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    const tenantA = await bootstrapOwner(request, 'a', 'Best-Tier HVAC 8.2');
    const seedA = await seedCustomerJob(request, tenantA, 'Taylor', '8.2 best-tier journey');
    const estA = await createAndSendGoodBetterBestEstimate(request, tenantA, seedA);

    const tenantB = await bootstrapOwner(request, 'b', 'Good-Tier Plumbing 8.2');
    const seedB = await seedCustomerJob(request, tenantB, 'Jesse', '8.2 good-tier journey');
    const estB = await createAndSendGoodBetterBestEstimate(request, tenantB, seedB);

    // ── Tenant A picks Best; tenant B picks Good — different choices, one run ─
    await pickSignAndApprove(page, estA.viewToken, 'Best Package', 'Alex A Signer', '8.2-tenant-a');
    await pickSignAndApprove(page, estB.viewToken, 'Good Package', 'Blair B Signer', '8.2-tenant-b');

    // ── Owner-side conversion, the real authenticated API route ──────────────
    const convertA = await request.post(`${API_URL}/api/estimates/${estA.estimateId}/convert-to-invoice`, {
      headers: tenantA.authHeaders,
    });
    expect(convertA.ok(), `convert A -> ${convertA.status()} ${await convertA.text()}`).toBeTruthy();
    const invoiceA = (await convertA.json()) as { id: string; totalCents?: number };

    const convertB = await request.post(`${API_URL}/api/estimates/${estB.estimateId}/convert-to-invoice`, {
      headers: tenantB.authHeaders,
    });
    expect(convertB.ok(), `convert B -> ${convertB.status()} ${await convertB.text()}`).toBeTruthy();
    const invoiceB = (await convertB.json()) as { id: string; totalCents?: number };

    // ── Tenant A: ONLY "Best Package" is a row; Good/Better/add-on absent ────
    const linesA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT description, total_cents FROM invoice_line_items WHERE invoice_id = $1`,
      [invoiceA.id],
    );
    const descriptionsA = linesA.map((l) => l.description as string);
    expect(descriptionsA).toEqual(['Best Package']);
    expect(linesA[0].total_cents).toBe(32_500);
    expect(descriptionsA).not.toContain('Good Package');
    expect(descriptionsA).not.toContain('Better Package');
    expect(descriptionsA).not.toContain('Extended Warranty (add-on)');

    const invRowA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT total_cents FROM invoices WHERE id = $1`,
      [invoiceA.id],
    );
    expect(invRowA[0].total_cents).toBe(32_500);

    // ── Tenant B: ONLY "Good Package" is a row; Better/Best/add-on absent ────
    const linesB = await queryAsTenant(
      tenantB.tenantId,
      `SELECT description, total_cents FROM invoice_line_items WHERE invoice_id = $1`,
      [invoiceB.id],
    );
    const descriptionsB = linesB.map((l) => l.description as string);
    expect(descriptionsB).toEqual(['Good Package']);
    expect(linesB[0].total_cents).toBe(15_000);
    expect(descriptionsB).not.toContain('Better Package');
    expect(descriptionsB).not.toContain('Best Package');
    expect(descriptionsB).not.toContain('Extended Warranty (add-on)');

    // ── estimate.converted audit, each tenant, correct total ─────────────────
    const convertedAuditA = await queryAsTenant(
      tenantA.tenantId,
      `SELECT metadata FROM audit_events WHERE tenant_id = $1 AND entity_type = 'estimate' AND entity_id = $2 AND event_type = 'estimate.converted'`,
      [tenantA.tenantId, estA.estimateId],
    );
    expect(convertedAuditA).toHaveLength(1);
    expect((convertedAuditA[0].metadata as { totalCents?: number }).totalCents).toBe(32_500);

    // ── T2 — tenant B's own scoped read never surfaces tenant A's invoice lines ─
    const crossRead = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM invoice_line_items WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantB.tenantId, invoiceA.id],
    );
    expect(crossRead).toHaveLength(0);
  });
});
