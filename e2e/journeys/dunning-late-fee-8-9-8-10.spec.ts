import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import {
  API_URL,
  bootstrapOwner,
  seedCustomerJob,
  seedIssuedInvoice,
  backdateInvoiceDueDate,
  queryAsTenant,
  pollUntilOk,
  pollRows,
} from '../fixtures/money-lane-8-8';

/**
 * 8.9 (dunning cadence, T4) + 8.10 (late fee) — rung-5 reachability.
 *
 * `runOverdueInvoiceSweep` (workers/overdue-invoice-worker.ts) is a real
 * LEADER-GATED background worker registered in app.ts, on an interval —
 * exactly like every other production sweep. It is gated behind
 * `shouldRunWorkers` (`PROCESS_ROLE === 'worker' | 'all'`), off by default
 * for the legacy webServer pair. This spec turns it ON for real
 * (`PROCESS_ROLE=all`, `OVERDUE_SWEEP_INTERVAL_MS` shortened so the run
 * finishes in reasonable time) and lets the REAL interval fire — no
 * function is ever called in-process, no admin route triggers it.
 *
 * Reaching "N days past due" needs a due date in the past. There is no
 * product surface that ever back-dates a due date (no real owner action
 * should exist to do that) — see e2e/qa-matrix/invoices.spec.ts:369 and
 * e2e/qa-matrix/payments-edge.spec.ts:212, this repo's own established,
 * narrowly-scoped precedent for exactly this gap (backdateInvoiceDueDate
 * in e2e/fixtures/money-lane-8-8.ts). Everything downstream of that one
 * clock field — the sweep run, the ledger writes, the proposals, the
 * audit trail — is 100% real surface.
 *
 * ── 8.10: the late-fee leg (flipped by #1143) ────────────────────────────
 * This spec originally PROVED A NEGATIVE: `DunningConfigRepository.upsert`
 * had no product caller, every tenant ran `defaultDunningConfig()`
 * (`lateFeeType: 'none'`), and `apply_late_fee` could never be proposed.
 * #1143 added the owner's write path — Settings → Payments & billing →
 * Late fees (packages/web DunningLateFeeSheet) → `PUT /api/settings/dunning`.
 * The owner now sets the policy IN THE REAL BROWSER (flat 50.00, 5-day
 * grace, capped at 20.00) before the invoice goes overdue; the REAL sweep
 * then drafts the fee clamped at the cap, the owner approves it through the
 * real approve route, and the REAL execution sweep lands the fee line. No
 * config row is ever written by this spec — only by the product.
 *
 * Run (one spec per process, dedicated ports, under the lane test lock):
 *   PORT=38630 E2E_API_URL=http://localhost:38630 PUBLIC_API_URL=http://localhost:38630 \
 *   VITE_API_URL=http://localhost:38630 E2E_WEB_PORT=38631 E2E_DEV_AUTH=0 E2E_NOAUTHBYPASS=0 \
 *   PROCESS_ROLE=all OVERDUE_SWEEP_INTERVAL_MS=4000 \
 *   CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=$DBU E2E_USE_TEST_DB=true \
 *   VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
 *   STRIPE_SECRET_KEY=sk_test_e2e_stub_placeholder STRIPE_WEBHOOK_SECRET=whsec_e2e_stub_secret_1234567890 \
 *   npx playwright test e2e/journeys/dunning-late-fee-8-9-8-10.spec.ts --project=chromium --retries=0 --workers=1
 */

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deliberately probe the real UNIQUE constraint the sweep relies on — not a business-state write, an infra assertion. */
async function rawInsertDunningEvent(
  tenantId: string,
  invoiceId: string,
  stepKey: string,
): Promise<{ code?: string } | null> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`SET app.current_tenant_id = '${tenantId.replace(/'/g, "''")}'`);
    await client.query(
      `INSERT INTO invoice_dunning_events (id, tenant_id, invoice_id, kind, step_key, sent_at)
       VALUES (gen_random_uuid(), $1, $2, 'reminder', $3, now())`,
      [tenantId, invoiceId, stepKey],
    );
    return null;
  } catch (err) {
    return err as { code?: string };
  } finally {
    await client.end().catch(() => undefined);
  }
}

test.describe('dunning cadence sweeps for real; the owner-set late fee is drafted, capped and applied (8.9 / 8.10) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    process.env.PROCESS_ROLE === 'all' &&
    !!process.env.OVERDUE_SWEEP_INTERVAL_MS;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres with the REAL overdue-invoice ' +
      'sweep turned on: leave E2E_BASE_URL unset, set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), ' +
      'E2E_USE_TEST_DB=true with DATABASE_URL pointing at the test container, PROCESS_ROLE=all, and ' +
      'OVERDUE_SWEEP_INTERVAL_MS (e.g. 4000) so the interval fires quickly in this run.',
  );

  test('a 15-days-overdue invoice, swept twice by the REAL interval, ends with exactly three reminder rows and proposals; a duplicate 7:sms insert raises 23505; the late fee the owner set in Settings is drafted once, clamped at the cap, and lands on the invoice after approval; a neighbour tenant is untouched', async ({
    request,
    page,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const sweepIntervalMs = Number(process.env.OVERDUE_SWEEP_INTERVAL_MS);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const tenantA = await bootstrapOwner(request, 'a', 'Dunning HVAC 8.9');

    // ── 8.10: the owner sets the late-fee policy in the REAL Settings UI ──
    // Before any invoice is overdue, so no sweep tick can precede the policy.
    await installClerkStub(page, { signedIn: true, sub: tenantA.ownerSub, token: tenantA.jwt });
    await page.addInitScript(
      ({ welcomeKey, whatsNewKey }) => {
        try {
          localStorage.setItem(welcomeKey, '1');
          localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
        } catch {
          /* private mode — ignore */
        }
      },
      { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
    );
    await blockExternalHosts(page, baseURL!);
    await page.goto('/settings');
    await page.getByText('Late fees', { exact: true }).click({ timeout: 15_000 });
    const sheet = page.getByRole('dialog', { name: 'Late fees' });
    await expect(sheet.getByLabel(/No late fee/)).toBeChecked({ timeout: 15_000 });
    await sheet.getByLabel(/Flat fee/).check();
    await sheet.getByLabel('Fee amount', { exact: true }).fill('50');
    await sheet.getByLabel(/Grace period/).fill('5');
    await sheet.getByLabel(/Maximum fee/).fill('20');
    await sheet.screenshot({ path: test.info().outputPath('late-fees-sheet.png') });
    const putPromise = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/settings/dunning',
    );
    await sheet.getByRole('button', { name: 'Save' }).click();
    const putRes = await putPromise;
    expect(putRes.status(), `PUT /api/settings/dunning -> ${putRes.status()}`).toBe(200);
    await expect(sheet).toBeHidden();

    // Read back through the real API — the durable proof the UI wrote it.
    const policyRes = await request.get(`${API_URL}/api/settings/dunning`, { headers: tenantA.authHeaders });
    expect(policyRes.status()).toBe(200);
    expect(await policyRes.json()).toMatchObject({
      configured: true,
      lateFeeType: 'flat',
      lateFeeValueCents: 5000,
      lateFeeGraceDays: 5,
      lateFeeMaxCents: 2000,
    });

    const seedA = await seedCustomerJob(request, tenantA, 'Harper', '8.9/8.10 dunning journey');
    const invoiceA = await seedIssuedInvoice(request, tenantA, seedA.jobId, 40_000, { paymentTermDays: 30 });
    await pollUntilOk(request, `${API_URL}/api/invoices/${invoiceA.invoiceId}`, tenantA.authHeaders);

    // ── Narrow, precedented clock-field exception (see header) ──────────
    await backdateInvoiceDueDate(tenantA.tenantId, invoiceA.invoiceId, 15);

    // ── Tenant B: a neighbour, NOT overdue, must stay untouched ──────────
    const tenantB = await bootstrapOwner(request, 'b', 'Untouched Plumbing 8.9');
    const seedB = await seedCustomerJob(request, tenantB, 'Indigo', '8.9 neighbour journey');
    const invoiceB = await seedIssuedInvoice(request, tenantB, seedB.jobId, 9_000, { paymentTermDays: 30 });
    await pollUntilOk(request, `${API_URL}/api/invoices/${invoiceB.invoiceId}`, tenantB.authHeaders);

    // ── Wait for the REAL sweep interval to fire at least ONCE ───────────
    const firstPassEvents = await pollRows(
      tenantA.tenantId,
      `SELECT step_key FROM invoice_dunning_events WHERE tenant_id = $1 AND invoice_id = $2 AND kind = 'reminder'`,
      [tenantA.tenantId, invoiceA.invoiceId],
      { timeoutMs: Math.max(30_000, sweepIntervalMs * 4), minRows: 3 },
    );
    expect(
      firstPassEvents.map((r) => r.step_key).sort(),
      'the real sweep raised all three due steps (elapsed=15d) on its first pass',
    ).toEqual(['14:sms', '3:sms', '7:sms']);

    // ── Wait for a SECOND real sweep tick, then confirm no duplicates ────
    await new Promise((r) => setTimeout(r, sweepIntervalMs * 2));
    const afterSecondPass = await queryAsTenant(
      tenantA.tenantId,
      `SELECT step_key FROM invoice_dunning_events WHERE tenant_id = $1 AND invoice_id = $2 AND kind = 'reminder'`,
      [tenantA.tenantId, invoiceA.invoiceId],
    );
    expect(afterSecondPass, 'swept twice: still exactly three rows, no resend').toHaveLength(3);

    // ── The real UNIQUE constraint refuses a duplicate '7:sms' ───────────
    const dupErr = await rawInsertDunningEvent(tenantA.tenantId, invoiceA.invoiceId, '7:sms');
    expect(dupErr, 'a duplicate 7:sms insert must be refused').not.toBeNull();
    expect(dupErr?.code).toBe('23505');

    // ── Three send_payment_reminder proposals + three dunning_proposed
    //    audit rows ───────────────────────────────────────────────────────
    const reminderProposals = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id, proposal_type, status, payload FROM proposals WHERE tenant_id = $1 AND proposal_type = 'send_payment_reminder'`,
      [tenantA.tenantId],
    );
    expect(reminderProposals).toHaveLength(3);
    for (const p of reminderProposals) {
      expect((p.id as string)).toMatch(UUID_RE);
      const payload = p.payload as { invoiceId?: string };
      expect(payload.invoiceId).toBe(invoiceA.invoiceId);
    }

    const dunningProposedAudit = await queryAsTenant(
      tenantA.tenantId,
      `SELECT metadata FROM audit_events WHERE tenant_id = $1 AND entity_type = 'invoice' AND entity_id = $2 AND event_type = 'invoice.dunning_proposed'`,
      [tenantA.tenantId, invoiceA.invoiceId],
    );
    expect(dunningProposedAudit.length).toBeGreaterThanOrEqual(3);
    const proposedReminderStepKeys = dunningProposedAudit
      .map((r) => (r.metadata as { stepKey?: string; proposalType?: string }))
      .filter((m) => m.proposalType === 'send_payment_reminder')
      .map((m) => m.stepKey)
      .sort();
    expect(proposedReminderStepKeys).toEqual(['14:sms', '3:sms', '7:sms']);

    // ── 8.10: the owner's late fee — drafted ONCE across both sweeps,
    //    clamped from 50.00 to the 20.00 cap ─────────────────────────────
    const lateFeeEvents = await queryAsTenant(
      tenantA.tenantId,
      `SELECT step_key, amount_cents FROM invoice_dunning_events WHERE tenant_id = $1 AND invoice_id = $2 AND kind = 'late_fee'`,
      [tenantA.tenantId, invoiceA.invoiceId],
    );
    expect(lateFeeEvents, 'exactly one late_fee ledger row across two sweeps').toHaveLength(1);
    expect(lateFeeEvents[0].step_key).toBe('initial');
    expect(Number(lateFeeEvents[0].amount_cents), 'the ledger holds the CLAMPED fee').toBe(2000);

    const lateFeeProposals = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id, status, payload FROM proposals WHERE tenant_id = $1 AND proposal_type = 'apply_late_fee'`,
      [tenantA.tenantId],
    );
    expect(lateFeeProposals, 'one apply_late_fee proposal drafted for the owner').toHaveLength(1);
    expect(lateFeeProposals[0].status).toBe('ready_for_review');
    expect(lateFeeProposals[0].payload).toMatchObject({ invoiceId: invoiceA.invoiceId, feeCents: 2000, stepKey: 'initial' });
    const proposedLateFeeAudit = dunningProposedAudit
      .map((r) => r.metadata as { proposalType?: string; feeCents?: number })
      .filter((m) => m.proposalType === 'apply_late_fee');
    expect(proposedLateFeeAudit).toHaveLength(1);
    expect(proposedLateFeeAudit[0].feeCents).toBe(2000);

    // Nothing is charged until the owner approves.
    const invoiceBeforeApproval = await request.get(`${API_URL}/api/invoices/${invoiceA.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    expect(((await invoiceBeforeApproval.json()) as { totals: { totalCents: number } }).totals.totalCents).toBe(40_000);

    // The owner approves through the real route; the REAL execution sweep
    // (1s interval, after the 5s undo window) appends the fee line.
    const lateFeeProposalId = lateFeeProposals[0].id as string;
    const approveRes = await request.post(`${API_URL}/api/proposals/${lateFeeProposalId}/approve`, {
      headers: { 'content-type': 'application/json', ...tenantA.authHeaders },
      data: '{}',
    });
    expect(approveRes.status(), `approve apply_late_fee -> ${approveRes.status()} ${await approveRes.text()}`).toBe(200);

    const feeLines = await pollRows(
      tenantA.tenantId,
      `SELECT description, total_cents FROM invoice_line_items WHERE invoice_id = $1 AND description = 'Late fee'`,
      [invoiceA.invoiceId],
      { timeoutMs: 30_000 },
    );
    expect(feeLines, 'the approved late fee lands as one invoice line').toHaveLength(1);
    expect(Number(feeLines[0].total_cents), 'the line carries the CLAMPED fee').toBe(2000);

    const lateFeeAudit = await pollRows(
      tenantA.tenantId,
      `SELECT metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'invoice.late_fee_applied'`,
      [tenantA.tenantId],
      { timeoutMs: 10_000 },
    );
    expect(lateFeeAudit).toHaveLength(1);
    expect(lateFeeAudit[0].metadata).toMatchObject({ feeCents: 2000, stepKey: 'initial' });

    const invoiceAfterFee = await request.get(`${API_URL}/api/invoices/${invoiceA.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    expect(((await invoiceAfterFee.json()) as { totals: { totalCents: number } }).totals.totalCents).toBe(42_000);

    // The owner-set policy was written by the product, never by this spec.
    const policyRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT late_fee_type, late_fee_value_cents, late_fee_grace_days, late_fee_max_cents FROM invoice_dunning_configs WHERE tenant_id = $1`,
      [tenantA.tenantId],
    );
    expect(policyRows).toHaveLength(1);
    expect(policyRows[0]).toMatchObject({ late_fee_type: 'flat', late_fee_grace_days: 5 });
    expect(Number(policyRows[0].late_fee_value_cents)).toBe(5000);
    expect(Number(policyRows[0].late_fee_max_cents)).toBe(2000);

    // ── T2: neighbour tenant (not overdue) is completely untouched ───────
    const neighbourEvents = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM invoice_dunning_events WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    expect(neighbourEvents).toHaveLength(0);
    const neighbourProposals = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM proposals WHERE tenant_id = $1 AND proposal_type IN ('send_payment_reminder', 'apply_late_fee')`,
      [tenantB.tenantId],
    );
    expect(neighbourProposals).toHaveLength(0);
    // Tenant A's policy is not B's: B has no config row and still reads the default.
    expect(
      await queryAsTenant(tenantB.tenantId, `SELECT id FROM invoice_dunning_configs WHERE tenant_id = $1`, [tenantB.tenantId]),
    ).toHaveLength(0);
    const neighbourPolicy = await request.get(`${API_URL}/api/settings/dunning`, { headers: tenantB.authHeaders });
    expect(await neighbourPolicy.json()).toMatchObject({ configured: false, lateFeeType: 'none' });
    const neighbourLines = await queryAsTenant(
      tenantB.tenantId,
      `SELECT description FROM invoice_line_items WHERE invoice_id = $1`,
      [invoiceB.invoiceId],
    );
    expect(neighbourLines.map((l) => l.description)).toEqual(['Service call']);

    expect(pageErrors, 'no uncaught page errors while setting the late-fee policy').toEqual([]);
    // Tenant A's events are invisible under tenant B's RLS session, too.
    const crossRead = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM invoice_dunning_events WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantB.tenantId, invoiceA.invoiceId],
    );
    expect(crossRead).toHaveLength(0);
  });
});
