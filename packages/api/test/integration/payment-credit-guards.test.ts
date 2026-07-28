/**
 * Postgres integration — the atomic invoice credit is guarded in SQL
 * (P0-3 / P0-6).
 *
 * The recordPayment serial guards (payable status, amount <= due) are
 * check-then-act against a stale in-memory read; the UPDATE they gate must
 * therefore carry its own predicates. Pins:
 *
 *  1. Two concurrent FULL-BALANCE payments cannot overpay: exactly one credit
 *     applies (`amount_paid_cents == total_cents`, never 2x), the loser's
 *     payment row is compensated to 'failed'.
 *  2. A voided invoice takes no credit: `incrementAmountPaidAtomic` returns
 *     null and the row keeps status 'void' — the forbidden void -> paid
 *     transition is structurally impossible at the SQL layer.
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
import { recordPayment } from '../../src/invoices/payment';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { Invoice } from '../../src/invoices/invoice';

describe('Postgres integration — atomic credit guards (P0-3 / P0-6)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  async function createOpenInvoice(totalCents: number): Promise<Invoice> {
    const invoiceId = crypto.randomUUID();
    const lineItems = [
      buildLineItem(crypto.randomUUID(), 'Service', 1, totalCents, 0, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    return invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: `INV-GUARD-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Guard',
      lastName: 'Rail',
      displayName: 'Guard Rail',
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
      street1: '2 Guard St',
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
    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-GUARD-1',
      summary: 'Credit guard job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('two concurrent full-balance payments credit the invoice exactly once (never 2x)', async () => {
    const invoice = await createOpenInvoice(30000);
    const mkInput = (ref: string) => ({
      tenantId: tenant.tenantId,
      invoiceId: invoice.id,
      amountCents: 30000,
      method: 'credit_card' as const,
      providerReference: ref,
      processedBy: 'stripe_webhook',
    });

    // Double-clicked pay button / payment link racing a Terminal charge: both
    // pass the serial guards against the same balance read. The SQL predicate
    // `amount_paid_cents + delta <= total_cents` must reject the second.
    const results = await Promise.allSettled([
      recordPayment(mkInput('pi_guard_race_a'), invoiceRepo, paymentRepo),
      recordPayment(mkInput('pi_guard_race_b'), invoiceRepo, paymentRepo),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reloaded = await invoiceRepo.findById(tenant.tenantId, invoice.id);
    expect(reloaded!.amountPaidCents).toBe(30000); // L4: paid <= total holds
    expect(reloaded!.amountDueCents).toBe(0);
    expect(reloaded!.status).toBe('paid');

    // Depending on how the two interleave, the loser is rejected either at
    // the serial guard (no row inserted) or at the SQL predicate (row
    // inserted, then compensated to 'failed'). Both are correct; what must
    // hold is exactly ONE completed row, so the paid-ledger sum (L3,
    // completed|processing and not reversed) equals the single credit.
    const { rows } = await pool.query<{ status: string; reversal_reason: string | null }>(
      `SELECT status, reversal_reason FROM payments
       WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY status`,
      [tenant.tenantId, invoice.id],
    );
    expect(rows.filter((r) => r.status === 'completed')).toHaveLength(1);
    for (const extra of rows.filter((r) => r.status !== 'completed')) {
      expect(extra.status).toBe('failed');
      expect(extra.reversal_reason).toBe('credit_rejected');
    }
  });

  it('the SQL overpay predicate rejects a second full-balance credit deterministically', async () => {
    const invoice = await createOpenInvoice(30000);

    const first = await invoiceRepo.incrementAmountPaidAtomic(
      tenant.tenantId,
      invoice.id,
      30000,
      new Date(),
    );
    expect(first!.status).toBe('paid');

    // Simulates the loser of the race arriving at the UPDATE after the winner
    // committed: 0 rows matched, null returned, balance untouched.
    const second = await invoiceRepo.incrementAmountPaidAtomic(
      tenant.tenantId,
      invoice.id,
      30000,
      new Date(),
    );
    expect(second).toBeNull();

    const reloaded = await invoiceRepo.findById(tenant.tenantId, invoice.id);
    expect(reloaded!.amountPaidCents).toBe(30000);
    expect(reloaded!.status).toBe('paid');
  });

  it('a voided invoice takes no credit — void -> paid is impossible at the SQL layer', async () => {
    const invoice = await createOpenInvoice(20000);
    await invoiceRepo.update(tenant.tenantId, invoice.id, {
      status: 'void',
      updatedAt: new Date(),
    });

    const result = await invoiceRepo.incrementAmountPaidAtomic(
      tenant.tenantId,
      invoice.id,
      20000,
      new Date(),
    );

    expect(result).toBeNull();
    const reloaded = await invoiceRepo.findById(tenant.tenantId, invoice.id);
    expect(reloaded!.status).toBe('void');
    expect(reloaded!.amountPaidCents).toBe(0);
  });

  it('payment-link CAS clear (P0-9/R3): clears only while the column holds the expected id', async () => {
    const invoice = await createOpenInvoice(5000);
    await invoiceRepo.update(tenant.tenantId, invoice.id, {
      stripePaymentLinkId: 'plink_cas_1',
      stripePaymentLinkUrl: 'https://pay.stripe.com/cas1',
      updatedAt: new Date(),
    });

    // Wrong expected id → no-op.
    expect(
      await invoiceRepo.clearPaymentLinkIfMatches(tenant.tenantId, invoice.id, 'plink_other'),
    ).toBe(false);
    let fresh = await invoiceRepo.findById(tenant.tenantId, invoice.id);
    expect(fresh!.stripePaymentLinkId).toBe('plink_cas_1');

    // Matching id → cleared.
    expect(
      await invoiceRepo.clearPaymentLinkIfMatches(tenant.tenantId, invoice.id, 'plink_cas_1'),
    ).toBe(true);
    fresh = await invoiceRepo.findById(tenant.tenantId, invoice.id);
    expect(fresh!.stripePaymentLinkId).toBeUndefined();
    expect(fresh!.stripePaymentLinkUrl).toBeUndefined();

    // Second clear finds nothing to match.
    expect(
      await invoiceRepo.clearPaymentLinkIfMatches(tenant.tenantId, invoice.id, 'plink_cas_1'),
    ).toBe(false);
  });

  it('a partial credit within the balance still applies (guards do not over-reject)', async () => {
    const invoice = await createOpenInvoice(10000);

    const first = await invoiceRepo.incrementAmountPaidAtomic(
      tenant.tenantId,
      invoice.id,
      4000,
      new Date(),
    );
    expect(first!.status).toBe('partially_paid');
    expect(first!.amountDueCents).toBe(6000);

    const second = await invoiceRepo.incrementAmountPaidAtomic(
      tenant.tenantId,
      invoice.id,
      6000,
      new Date(),
    );
    expect(second!.status).toBe('paid');
    expect(second!.amountPaidCents).toBe(10000);
  });
});
