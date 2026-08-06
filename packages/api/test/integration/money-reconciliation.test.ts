/**
 * Postgres integration — money-invariant reconciliation sweep (L2–L5).
 *
 * Pins the sweep's SQL against REAL Postgres (column names, the nested
 * webhook payload path, the tenant-scoped payment join) — a mocked pool
 * cannot prove any of that. Seeds, in one tenant:
 *   - a clean invoice (all gates pass, L5 pass via a matching event),
 *   - a fully-refunded invoice (must PASS L3 — refund-INCLUSIVE),
 *   - an L3 violation (counter drifted above the payment ledger),
 *   - an L4 violation (P0-6 double-credit: L3 green, invoice overpaid),
 *   - an L5 mismatch (Stripe captured more than the recorded payments, P0-9),
 *   - two UNVERIFIABLE checkout events (legacy 'stripe_checkout' literal and
 *     a payload with no payment_intent at all — P0-5 caveat),
 *   - an L1 legacy line-item rounding mismatch (informational count only),
 * plus a second tenant whose payment reuses the L5 provider reference to
 * prove the L5 join is tenant-scoped, and asserts THE WORKER MUTATES NOTHING
 * (audit_events is its only write).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createLogger } from '../../src/logging/logger';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { Payment } from '../../src/invoices/payment';
import {
  PgMoneyReconciliationReader,
  runMoneyReconciliationSweep,
  MONEY_RECONCILIATION_AUDIT_EVENT_TYPE,
  type MoneyReconciliationSummary,
} from '../../src/workers/money-reconciliation';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/** Tables the read-only sweep must leave byte-identical. */
const MONEY_TABLES = ['invoices', 'invoice_line_items', 'payments', 'webhook_events', 'jobs', 'tenants'];

async function tableDigest(pool: Pool, table: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM ${table} t`,
  );
  return rows[0].digest as string;
}

describe('money reconciliation sweep (L2–L5, DB-level)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };
  let jobIdA = '';
  let jobIdB = '';

  let invClean = '';
  let invRefunded = '';
  let invL3 = '';
  let invL4 = '';
  let invL5 = '';
  let invL1 = '';
  let evClean = '';
  let evL5Mismatch = '';
  let evUnvLegacy = '';
  let evUnvNoIntent = '';

  let summary: MoneyReconciliationSummary;
  const digestsBefore: Record<string, string> = {};

  async function seedJob(tenant: { tenantId: string; userId: string }): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Recon',
      lastName: 'Sweep',
      displayName: 'Recon Sweep',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Invariant Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: 'Reconciliation seed job',
      status: 'completed',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  async function seedInvoice(opts: {
    tenant: { tenantId: string; userId: string };
    jobId: string;
    unitPriceCents: number;
    quantity?: number;
    amountPaidCents: number;
    status: 'open' | 'partially_paid' | 'paid';
  }): Promise<string> {
    const id = crypto.randomUUID();
    const lineItems = [
      buildLineItem(crypto.randomUUID(), 'Service', opts.quantity ?? 1, opts.unitPriceCents, 0, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id,
      tenantId: opts.tenant.tenantId,
      jobId: opts.jobId,
      invoiceNumber: `INV-${id.slice(0, 8)}`,
      status: opts.status,
      lineItems,
      totals,
      amountPaidCents: opts.amountPaidCents,
      amountDueCents: Math.max(0, totals.totalCents - opts.amountPaidCents),
      createdBy: opts.tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function seedPayment(opts: {
    tenant: { tenantId: string };
    invoiceId: string;
    amountCents: number;
    providerReference: string;
    refundedAmountCents?: number;
  }): Promise<void> {
    const payment: Payment = {
      id: crypto.randomUUID(),
      tenantId: opts.tenant.tenantId,
      invoiceId: opts.invoiceId,
      amountCents: opts.amountCents,
      method: 'credit_card',
      status: 'completed',
      providerReference: opts.providerReference,
      receivedAt: new Date(),
      processedBy: 'stripe_webhook',
      createdAt: new Date(),
      updatedAt: new Date(),
      refundedAmountCents: opts.refundedAmountCents ?? 0,
      refundedAt: opts.refundedAmountCents ? new Date() : null,
      lastRefundStripeId: opts.refundedAmountCents ? `re_${crypto.randomUUID().slice(0, 8)}` : null,
      reversedAt: null,
      reversalReason: null,
    };
    await paymentRepo.create(payment);
  }

  /** Persist a checkout.session.completed row exactly as the route does: payload = event.data. */
  async function seedCheckoutEvent(opts: {
    tenantId: string;
    invoiceId: string;
    amountTotal: number;
    paymentIntent?: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const object: Record<string, unknown> = {
      id: `cs_test_${id.slice(0, 8)}`,
      metadata: { tenant_id: opts.tenantId, invoice_id: opts.invoiceId },
      amount_total: opts.amountTotal,
      payment_status: 'paid',
    };
    if (opts.paymentIntent !== undefined) object.payment_intent = opts.paymentIntent;
    await pool.query(
      `INSERT INTO webhook_events (id, source, event_type, idempotency_key, payload, status, processed_at)
       VALUES ($1, 'stripe', 'checkout.session.completed', $2, $3::jsonb, 'processed', NOW())`,
      [id, `evt_${id}`, JSON.stringify({ object })],
    );
    return id;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    jobIdA = await seedJob(tenantA);
    jobIdB = await seedJob(tenantB);

    // 1. Clean: $300 invoice, one completed $300 payment, matching L5 event.
    invClean = await seedInvoice({ tenant: tenantA, jobId: jobIdA, unitPriceCents: 30000, amountPaidCents: 30000, status: 'paid' });
    await seedPayment({ tenant: tenantA, invoiceId: invClean, amountCents: 30000, providerReference: 'pi_clean_1' });
    evClean = await seedCheckoutEvent({ tenantId: tenantA.tenantId, invoiceId: invClean, amountTotal: 30000, paymentIntent: 'pi_clean_1' });

    // 2. Fully refunded: refunds do NOT write back — L3 must still pass.
    invRefunded = await seedInvoice({ tenant: tenantA, jobId: jobIdA, unitPriceCents: 10000, amountPaidCents: 10000, status: 'paid' });
    await seedPayment({ tenant: tenantA, invoiceId: invRefunded, amountCents: 10000, providerReference: 'pi_refunded_1', refundedAmountCents: 10000 });

    // 3. L3 violation: counter says $50 paid, payment ledger is empty.
    invL3 = await seedInvoice({ tenant: tenantA, jobId: jobIdA, unitPriceCents: 20000, amountPaidCents: 5000, status: 'partially_paid' });

    // 4. L4 violation (P0-6 shape): $300 invoice double-credited to $400 with
    //    matching payment rows, so L3 passes and only L4 can catch it.
    invL4 = await seedInvoice({ tenant: tenantA, jobId: jobIdA, unitPriceCents: 30000, amountPaidCents: 40000, status: 'paid' });
    await seedPayment({ tenant: tenantA, invoiceId: invL4, amountCents: 20000, providerReference: 'pi_l4_a' });
    await seedPayment({ tenant: tenantA, invoiceId: invL4, amountCents: 20000, providerReference: 'pi_l4_b' });

    // 5. L5 mismatch (P0-9 shape): Stripe captured $300, only $200 recorded.
    //    The invoice itself is internally consistent — only L5 sees the gap.
    invL5 = await seedInvoice({ tenant: tenantA, jobId: jobIdA, unitPriceCents: 20000, amountPaidCents: 20000, status: 'paid' });
    await seedPayment({ tenant: tenantA, invoiceId: invL5, amountCents: 20000, providerReference: 'pi_l5_1' });
    evL5Mismatch = await seedCheckoutEvent({ tenantId: tenantA.tenantId, invoiceId: invL5, amountTotal: 30000, paymentIntent: 'pi_l5_1' });

    // 6. Unverifiable events: the legacy P0-5 'stripe_checkout' literal, and a
    //    payload with no payment_intent at all. Neither may pass OR fail.
    evUnvLegacy = await seedCheckoutEvent({ tenantId: tenantA.tenantId, invoiceId: invClean, amountTotal: 5000, paymentIntent: 'stripe_checkout' });
    evUnvNoIntent = await seedCheckoutEvent({ tenantId: tenantA.tenantId, invoiceId: invClean, amountTotal: 7000 });

    // 7. L1 legacy rounding mismatch: qty 0.5 × 29¢ — the engine stores 15,
    //    the legacy float client wrote 14. Keep the invoice's own counters in
    //    agreement with the (wrong) line so ONLY L1 flags it.
    invL1 = await seedInvoice({ tenant: tenantA, jobId: jobIdA, unitPriceCents: 29, quantity: 0.5, amountPaidCents: 0, status: 'open' });
    await pool.query(`UPDATE invoice_line_items SET total_cents = 14 WHERE invoice_id = $1`, [invL1]);
    await pool.query(`UPDATE invoices SET subtotal_cents = 14, taxable_subtotal_cents = 14, total_cents = 14, amount_due_cents = 14 WHERE id = $1`, [invL1]);

    // Tenant B: clean invoice whose payment REUSES tenant A's L5 reference.
    // If the L5 join were not tenant-scoped, B's $100 would top A's sum up to
    // $300 and hide the mismatch.
    const invB = await seedInvoice({ tenant: tenantB, jobId: jobIdB, unitPriceCents: 10000, amountPaidCents: 10000, status: 'paid' });
    await seedPayment({ tenant: tenantB, invoiceId: invB, amountCents: 10000, providerReference: 'pi_l5_1' });

    for (const table of MONEY_TABLES) {
      digestsBefore[table] = await tableDigest(pool, table);
    }

    summary = await runMoneyReconciliationSweep({
      reader: new PgMoneyReconciliationReader(pool),
      auditRepo: new PgAuditRepository(pool),
      listTenantIds: async () => [tenantA.tenantId, tenantB.tenantId],
      logger,
    });
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('passes every gate on the clean, the refunded (refund-INCLUSIVE L3), and tenant B invoices', () => {
    expect(summary.tenants).toBe(2);
    expect(summary.failedTenants).toBe(0);
    // 6 tenant-A invoices + 1 tenant-B invoice checked per invoice gate.
    expect(summary.gates.l2_subtotal).toEqual({ checked: 7, violations: 0, unverifiable: 0 });
    expect(summary.gates.l2_total).toEqual({ checked: 7, violations: 0, unverifiable: 0 });
    expect(summary.violatingInvoiceIds).not.toContain(invClean);
    expect(summary.violatingInvoiceIds).not.toContain(invRefunded);
  });

  it('flags the L3 drift (and only it) on the counter-vs-ledger invoice', () => {
    expect(summary.gates.l3).toEqual({ checked: 7, violations: 1, unverifiable: 0 });
    expect(summary.violatingInvoiceIds).toContain(invL3);
  });

  it('flags the L4 overpayment even though its payment rows keep L3 green', () => {
    expect(summary.gates.l4).toEqual({ checked: 7, violations: 1, unverifiable: 0 });
    expect(summary.violatingInvoiceIds).toContain(invL4);
    expect(summary.violatingInvoiceIds).toHaveLength(2); // exactly invL3 + invL4
  });

  it('flags the L5 capture mismatch with a tenant-scoped payment join', () => {
    expect(summary.gates.l5.checked).toBe(2); // evClean + evL5Mismatch
    expect(summary.gates.l5.violations).toBe(1);
    expect(summary.violatingEventIds).toEqual([evL5Mismatch]);
    expect(summary.violatingEventIds).not.toContain(evClean);
  });

  it("counts the legacy 'stripe_checkout' and missing-payment_intent rows as UNVERIFIABLE, never pass/fail", () => {
    expect(summary.gates.l5.unverifiable).toBe(2);
    expect(summary.violatingEventIds).not.toContain(evUnvLegacy);
    expect(summary.violatingEventIds).not.toContain(evUnvNoIntent);
  });

  it('reports the L1 legacy rounding mismatch as an informational count only', () => {
    // 6 tenant-A lines + 1 tenant-B line; exactly the doctored one mismatches.
    expect(summary.gates.l1).toEqual({ checked: 7, violations: 1, unverifiable: 0 });
    expect(summary.violatingInvoiceIds).not.toContain(invL1);
  });

  it('emits audit events for exactly the three violations, with the tenant-scoped L5 sum', async () => {
    const { rows } = await pool.query(
      `SELECT entity_type, entity_id, metadata FROM audit_events
       WHERE tenant_id = $1 AND event_type = $2 ORDER BY created_at`,
      [tenantA.tenantId, MONEY_RECONCILIATION_AUDIT_EVENT_TYPE],
    );
    expect(rows.map((r) => r.entity_id).sort()).toEqual([evL5Mismatch, invL3, invL4].sort());

    const l5Audit = rows.find((r) => r.entity_id === evL5Mismatch);
    expect(l5Audit.entity_type).toBe('webhook_event');
    // actual = 20000 proves tenant B's colliding 10000 payment was NOT joined in.
    expect(l5Audit.metadata).toMatchObject({ gate: 'l5', expected: 30000, actual: 20000, providerReference: 'pi_l5_1' });

    const l3Audit = rows.find((r) => r.entity_id === invL3);
    expect(l3Audit.entity_type).toBe('invoice');
    expect(l3Audit.metadata).toMatchObject({ gate: 'l3', expected: 0, actual: 5000 });

    const l4Audit = rows.find((r) => r.entity_id === invL4);
    expect(l4Audit.metadata).toMatchObject({ gate: 'l4', expected: 30000, actual: 40000 });

    const { rows: tenantBRows } = await pool.query(
      `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = $2`,
      [tenantB.tenantId, MONEY_RECONCILIATION_AUDIT_EVENT_TYPE],
    );
    expect(tenantBRows).toEqual([]);
  });

  it('mutates nothing: every money table is byte-identical after the sweep', async () => {
    for (const table of MONEY_TABLES) {
      expect(await tableDigest(pool, table), `table ${table} changed`).toBe(digestsBefore[table]);
    }
  });
});
