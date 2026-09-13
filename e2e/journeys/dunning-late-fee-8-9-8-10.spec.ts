import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { hasViteClerkKey } from '../helpers/clerk-key';
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
 * ── 8.10's honest finding (read before changing this file) ──────────────
 * `DunningConfigRepository.upsert` (invoices/dunning-config.ts:159) has
 * ZERO callers anywhere in packages/api/src outside its own repo/tests
 * (grepped). Every tenant therefore runs `defaultDunningConfig()`
 * (dunning-config.ts:141) forever: `lateFeeType: 'none'`. There is no
 * voice intent, no REST route, and no packages/web UI (grepped) that ever
 * sets a tenant's dunning/late-fee policy. `computeLateFeeCents` (called
 * from overdue-invoice-worker.ts:349) returns 0 for `lateFeeType: 'none'`
 * by construction, so `apply_late_fee` (:355) can NEVER be proposed for
 * ANY tenant in this product today — not a reachability gap this lane can
 * close (no LLM turn, no live third-party, no missing test wiring — just
 * no product surface exists), and not something a test-only lane may
 * create by writing the config row via SQL (that IS the state the
 * product should — and currently cannot — produce). Filed for Fable,
 * not invented here: this test PROVES the negative (no proposal, no
 * audit row, no line item) rather than skip it silently.
 */

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

test.describe('dunning cadence sweeps for real; late fee is a genuine product gap (8.9 / 8.10) — real Postgres', () => {
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

  test('a 15-days-overdue invoice, swept twice by the REAL interval, ends with exactly three dunning rows and three reminder proposals; a duplicate 7:sms insert raises 23505; NO late fee is ever proposed (no config surface exists); a neighbour tenant is untouched', async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const sweepIntervalMs = Number(process.env.OVERDUE_SWEEP_INTERVAL_MS);

    const tenantA = await bootstrapOwner(request, 'a', 'Dunning HVAC 8.9');
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

    // ── 8.10: NO late fee, ever — the genuine product gap, proven as a
    //    negative rather than assumed ───────────────────────────────────
    const lateFeeEvents = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id FROM invoice_dunning_events WHERE tenant_id = $1 AND invoice_id = $2 AND kind = 'late_fee'`,
      [tenantA.tenantId, invoiceA.invoiceId],
    );
    expect(lateFeeEvents, 'no late_fee ledger row — lateFeeType is permanently none').toHaveLength(0);

    const lateFeeProposals = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id FROM proposals WHERE tenant_id = $1 AND proposal_type = 'apply_late_fee'`,
      [tenantA.tenantId],
    );
    expect(lateFeeProposals, 'no apply_late_fee proposal was ever drafted').toHaveLength(0);

    const lateFeeAudit = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'invoice.late_fee_applied'`,
      [tenantA.tenantId],
    );
    expect(lateFeeAudit).toHaveLength(0);

    const invoiceLines = await queryAsTenant(
      tenantA.tenantId,
      `SELECT description FROM invoice_line_items WHERE invoice_id = $1`,
      [invoiceA.invoiceId],
    );
    expect(
      invoiceLines.some((l) => String(l.description).toLowerCase().includes('late fee')),
      'no late-fee line item exists on the invoice',
    ).toBeFalsy();
    const invoiceAfterSweeps = await request.get(`${API_URL}/api/invoices/${invoiceA.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    expect(((await invoiceAfterSweeps.json()) as { totals: { totalCents: number } }).totals.totalCents).toBe(40_000);

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
    // Tenant A's events are invisible under tenant B's RLS session, too.
    const crossRead = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM invoice_dunning_events WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantB.tenantId, invoiceA.invoiceId],
    );
    expect(crossRead).toHaveLength(0);
  });
});
