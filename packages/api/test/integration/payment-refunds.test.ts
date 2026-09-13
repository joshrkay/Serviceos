/**
 * Postgres integration — D2-4a / P0-4 per-refund idempotency ledger.
 *
 * Pins the real columns + the single-statement claim/increment CTE in
 * PgPaymentRepository.recordRefundIdempotent against real Postgres (a mocked
 * Pool cannot prove the CTE, the (tenant_id, stripe_refund_id) unique index,
 * or the FOR UPDATE serialization):
 *
 *  1. earlier-refund-retried-after-later-refund is deduped (the P0-4 interleave)
 *  2. concurrent same-refund deliveries apply exactly once
 *  3. an over-refund rejection strands no claim row
 *  4. RLS: the claim ledger is invisible cross-tenant
 *
 * #1022 row 8.8 addition — the refund must adjust the record WITHOUT lying
 * about what happened, so the audit leg is read back through the real
 * PgAuditRepository too: the original payment row keeps its full history
 * (amount_cents untouched, still 'completed'), each applied refund leaves one
 * `payment.refunded` event carrying its delta and the new cumulative total, a
 * deduped redelivery leaves none, and a neighbour tenant can read neither the
 * claim rows nor the audit events.
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
import { recordRefund } from '../../src/payments/payment-service';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { Payment } from '../../src/invoices/payment';

describe('Postgres integration — payment_refunds idempotency ledger (P0-4)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let invoiceId: string;

  async function createPayment(amountCents: number): Promise<Payment> {
    return paymentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      invoiceId,
      amountCents,
      method: 'credit_card',
      status: 'completed',
      providerReference: `pi_${crypto.randomUUID()}`,
      receivedAt: new Date(),
      processedBy: 'stripe_webhook',
      createdAt: new Date(),
      updatedAt: new Date(),
      refundedAmountCents: 0,
      refundedAt: null,
      lastRefundStripeId: null,
      reversedAt: null,
      reversalReason: null,
    });
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Ref',
      lastName: 'Und',
      displayName: 'Ref Und',
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
      street1: '3 Refund Rd',
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
      jobNumber: 'JOB-REFUND-1',
      summary: 'Refund ledger job',
      status: 'completed',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    invoiceId = crypto.randomUUID();
    const lineItems = [
      buildLineItem(crypto.randomUUID(), 'Service', 1, 100000, 0, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: 'INV-REFUND-1',
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('P0-4 interleave: an earlier refund retried after a later refund is deduped', async () => {
    const payment = await createPayment(10000);

    const r1 = await recordRefund(
      { tenantId: tenant.tenantId, paymentId: payment.id, refundCents: 3000, stripeRefundId: 're_pg_1' },
      paymentRepo,
      auditRepo,
    );
    expect(r1.totalRefundedCents).toBe(3000);

    const r2 = await recordRefund(
      { tenantId: tenant.tenantId, paymentId: payment.id, refundCents: 2000, stripeRefundId: 're_pg_2' },
      paymentRepo,
      auditRepo,
    );
    expect(r2.totalRefundedCents).toBe(5000);

    // Stripe retries re_pg_1's failed event: last_refund_stripe_id is re_pg_2,
    // so the old short-circuit would re-apply. The unique claim must not.
    const retry = await recordRefund(
      { tenantId: tenant.tenantId, paymentId: payment.id, refundCents: 3000, stripeRefundId: 're_pg_1' },
      paymentRepo,
      auditRepo,
    );
    expect(retry.refundCents).toBe(0);
    expect(retry.totalRefundedCents).toBe(5000);

    const { rows } = await pool.query<{ n: number; total: string }>(
      `SELECT count(*)::int AS n, COALESCE(sum(amount_cents), 0)::text AS total
       FROM payment_refunds WHERE tenant_id = $1 AND payment_id = $2`,
      [tenant.tenantId, payment.id],
    );
    expect(rows[0].n).toBe(2); // one claim per distinct refund
    expect(Number(rows[0].total)).toBe(5000);

    // The record is ADJUSTED, not rewritten: the original payment row keeps
    // its full magnitude and its settled status; only the cumulative refund
    // columns move. (D2-4: "the original row keeps its full amountCents for
    // accounting integrity".)
    const original = await pool.query<{
      amount_cents: string;
      status: string;
      refunded_amount_cents: string;
      last_refund_stripe_id: string | null;
    }>(
      `SELECT amount_cents::text, status, refunded_amount_cents::text, last_refund_stripe_id
         FROM payments WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, payment.id],
    );
    expect(Number(original.rows[0].amount_cents)).toBe(10000);
    expect(original.rows[0].status).toBe('completed');
    expect(Number(original.rows[0].refunded_amount_cents)).toBe(5000);

    // …and each APPLIED refund left exactly one audit event, read back
    // through the real PgAuditRepository. The deduped redelivery returns
    // before the audit write, so it must add nothing — three events here
    // would claim 8000 was refunded when 5000 was.
    const events = await auditRepo.findByEntity(tenant.tenantId, 'payment', payment.id);
    const refunded = events.filter((e) => e.eventType === 'payment.refunded');
    expect(refunded).toHaveLength(2);
    const byRefundId = new Map(refunded.map((e) => [e.metadata!.stripeRefundId as string, e]));
    expect(byRefundId.get('re_pg_1')!.metadata!.refundCents).toBe(3000);
    expect(byRefundId.get('re_pg_1')!.metadata!.totalRefundedCents).toBe(3000);
    expect(byRefundId.get('re_pg_2')!.metadata!.refundCents).toBe(2000);
    expect(byRefundId.get('re_pg_2')!.metadata!.totalRefundedCents).toBe(5000);
    // The provider refund id is the correlation key for reconciliation.
    expect(byRefundId.get('re_pg_2')!.correlationId).toBe('re_pg_2');
    expect(refunded.every((e) => e.tenantId === tenant.tenantId)).toBe(true);
  });

  it('two concurrent deliveries of one refund id apply exactly once (FOR UPDATE + unique claim)', async () => {
    const payment = await createPayment(10000);

    const results = await Promise.all([
      recordRefund(
        { tenantId: tenant.tenantId, paymentId: payment.id, refundCents: 4000, stripeRefundId: 're_pg_conc' },
        paymentRepo,
      ),
      recordRefund(
        { tenantId: tenant.tenantId, paymentId: payment.id, refundCents: 4000, stripeRefundId: 're_pg_conc' },
        paymentRepo,
      ),
    ]);

    expect(results.filter((r) => r.refundCents === 4000)).toHaveLength(1);
    expect(results.filter((r) => r.refundCents === 0)).toHaveLength(1);
    const reloaded = await paymentRepo.findById(tenant.tenantId, payment.id);
    expect(Number(reloaded!.refundedAmountCents)).toBe(4000);
  });

  it('a rejected over-refund strands no claim row — a corrected retry still applies', async () => {
    const payment = await createPayment(10000);

    await expect(
      recordRefund(
        { tenantId: tenant.tenantId, paymentId: payment.id, refundCents: 20000, stripeRefundId: 're_pg_over' },
        paymentRepo,
      ),
    ).rejects.toThrow(/Refund exceeds original payment/);

    const { rows } = await pool.query(
      `SELECT 1 FROM payment_refunds WHERE tenant_id = $1 AND stripe_refund_id = 're_pg_over'`,
      [tenant.tenantId],
    );
    expect(rows).toHaveLength(0);

    const corrected = await recordRefund(
      { tenantId: tenant.tenantId, paymentId: payment.id, refundCents: 10000, stripeRefundId: 're_pg_over' },
      paymentRepo,
    );
    expect(corrected.totalRefundedCents).toBe(10000);
  });

  it('RLS: refund claims are invisible to another tenant', async () => {
    const payment = await createPayment(10000);
    await recordRefund(
      { tenantId: tenant.tenantId, paymentId: payment.id, refundCents: 1000, stripeRefundId: 're_pg_rls' },
      paymentRepo,
      auditRepo,
    );

    const otherTenant = await createTestTenant(pool);
    // A same-id refund attempt from another tenant must not see (or be
    // deduped by) this tenant's claim — it fails on ITS missing payment row.
    await expect(
      recordRefund(
        { tenantId: otherTenant.tenantId, paymentId: payment.id, refundCents: 1000, stripeRefundId: 're_pg_rls' },
        paymentRepo,
        auditRepo,
      ),
    ).rejects.toThrow(/Payment/);

    // The refund is on THIS tenant's audit trail…
    expect(
      (await auditRepo.findByEntity(tenant.tenantId, 'payment', payment.id)).filter(
        (e) => e.eventType === 'payment.refunded',
      ),
    ).toHaveLength(1);
    // …and invisible to the neighbour, who also wrote no event of its own
    // (the rejection happens before the audit leg).
    expect(await auditRepo.findByEntity(otherTenant.tenantId, 'payment', payment.id)).toEqual([]);
    // The claim ledger stays one-sided too.
    const claims = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_refunds WHERE tenant_id = $1 AND stripe_refund_id = 're_pg_rls'`,
      [otherTenant.tenantId],
    );
    expect(claims.rows[0].n).toBe(0);
  });
});

describe('Postgres integration — migration 264 backfills legacy refund claims', () => {
  let pool: Pool;
  let paymentRepo: PgPaymentRepository;
  let invoiceRepo: PgInvoiceRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    paymentRepo = new PgPaymentRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a pre-ledger refund (last_refund_stripe_id only) gains a claim on re-run and dedupes redelivery', async () => {
    // Minimal fixture chain for a payment row.
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId, tenantId: tenant.tenantId, firstName: 'Leg', lastName: 'Acy',
      displayName: 'Leg Acy', preferredChannel: 'phone', smsConsent: false,
      isArchived: false, createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId, tenantId: tenant.tenantId, customerId, street1: '4 Legacy Ln',
      city: 'Austin', state: 'TX', postalCode: '78701', country: 'USA', isPrimary: true,
      addressType: 'service', isArchived: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId, tenantId: tenant.tenantId, customerId, locationId, jobNumber: 'JOB-LEGACY-1',
      summary: 'Legacy refund job', status: 'completed', priority: 'normal',
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    const invoiceId = crypto.randomUUID();
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, 10000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId, tenantId: tenant.tenantId, jobId, invoiceNumber: 'INV-LEGACY-1',
      status: 'open', lineItems, totals, amountPaidCents: 0, amountDueCents: totals.totalCents,
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });

    // Pre-264 shape: refund recorded on the payments row, NO claim.
    const payment = await paymentRepo.create({
      id: crypto.randomUUID(), tenantId: tenant.tenantId, invoiceId,
      amountCents: 10000, method: 'credit_card', status: 'completed',
      providerReference: `pi_${crypto.randomUUID()}`, receivedAt: new Date(),
      processedBy: 'stripe_webhook', createdAt: new Date(), updatedAt: new Date(),
      refundedAmountCents: 3000, refundedAt: new Date(),
      lastRefundStripeId: 're_legacy_bf', reversedAt: null, reversalReason: null,
    });
    await pool.query(
      `DELETE FROM payment_refunds WHERE tenant_id = $1 AND stripe_refund_id = 're_legacy_bf'`,
      [tenant.tenantId],
    );

    // Deploy-time behavior: the (idempotent) migration block re-runs and
    // seeds a claim for the legacy refund id.
    const { MIGRATIONS } = await import('../../src/db/schema');
    await pool.query(MIGRATIONS['264_create_payment_refunds']);

    const { rows } = await pool.query(
      `SELECT payment_id, amount_cents::int AS amount FROM payment_refunds
       WHERE tenant_id = $1 AND stripe_refund_id = 're_legacy_bf'`,
      [tenant.tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payment_id).toBe(payment.id);
    expect(rows[0].amount).toBe(3000);

    // A late redelivery of the legacy refund is now deduped by the claim —
    // even though last_refund_stripe_id could since have been overwritten.
    const retry = await recordRefund(
      { tenantId: tenant.tenantId, paymentId: payment.id, refundCents: 3000, stripeRefundId: 're_legacy_bf' },
      paymentRepo,
    );
    expect(retry.refundCents).toBe(0);
    expect(Number(retry.payment.refundedAmountCents)).toBe(3000); // NOT 6000
  });
});
