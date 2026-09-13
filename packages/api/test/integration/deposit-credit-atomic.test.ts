/**
 * Postgres integration — the deposit credit is an atomic guarded increment
 * (Track-5, mirroring P0-3 / P0-6).
 *
 * applyDepositCreditToInvoice was the last read-modify-write writer of the
 * invoice balance columns: it computed `snapshot.amountPaidCents + credit`
 * from an earlier in-call read and wrote it absolutely via the generic
 * update(), so a concurrent credit landing via incrementAmountPaidAtomic
 * between the read and the write was silently overwritten (lost update —
 * amount_paid_cents drops below the active payment-ledger sum), and it
 * bypassed the payable-status / balance-cap predicates. Pins:
 *
 *  1. The credit lands on the real 'draft' row both call sites produce, and
 *     the draft STAYS draft (issuing remains the operator's explicit step).
 *  2. Lost-update interleave: a concurrent incrementAmountPaidAtomic credit
 *     between the deposit-credit read and write is NOT overwritten — the
 *     final amount_paid is the sum of both credits.
 *  3. A voided invoice takes no deposit credit: the rejection is surfaced,
 *     the already-inserted deposit payment row is compensated to 'failed'
 *     (never orphaned as a completed row), and the job's deposit is released.
 *  4. The SQL balance cap: a credit that no longer fits the remaining
 *     balance matches 0 rows — amount_paid can never exceed total_cents.
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
import { applyDepositCreditToInvoice } from '../../src/invoices/deposit-credit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { Invoice, InvoiceStatus } from '../../src/invoices/invoice';

describe('Postgres integration — deposit credit atomic guards (Track-5)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let locationId: string;

  /** Each test seeds its OWN job: the deposit-consumed marker is per job. */
  async function seedDepositJob(depositPaidCents: number): Promise<string> {
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-DCA-${jobId.slice(0, 6)}`,
      summary: 'Deposit credit atomic job',
      status: 'completed',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // create() doesn't persist deposit columns; production sets them via
    // update/creditDepositAtomic (same approach as deposit-concurrent-credit).
    await jobRepo.update(tenant.tenantId, jobId, {
      depositRequiredCents: depositPaidCents,
      depositPaidCents,
      depositStatus: 'paid',
    });
    return jobId;
  }

  async function createInvoice(
    jobId: string,
    totalCents: number,
    status: InvoiceStatus,
  ): Promise<Invoice> {
    const invoiceId = crypto.randomUUID();
    const lineItems = [
      buildLineItem(crypto.randomUUID(), 'Service', 1, totalCents, 0, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    return invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: `INV-DCA-${invoiceId.slice(0, 8)}`,
      status,
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
    jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Dep',
      lastName: 'Atomic',
      displayName: 'Dep Atomic',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '5 Atomic Way',
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
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('credits the freshly-created draft invoice and PRESERVES draft status', async () => {
    const jobId = await seedDepositJob(25000);
    const job = (await jobRepo.findById(tenant.tenantId, jobId))!;
    const invoice = await createInvoice(jobId, 100000, 'draft');

    const result = await applyDepositCreditToInvoice(
      invoice,
      job,
      invoiceRepo,
      paymentRepo,
      jobRepo,
    );

    expect(result?.creditCents).toBe(25000);
    expect(result?.invoice.amountPaidCents).toBe(25000);
    expect(result?.invoice.amountDueCents).toBe(75000);
    expect(result?.invoice.status).toBe('draft');

    const afterJob = await jobRepo.findById(tenant.tenantId, jobId);
    expect(afterJob?.depositCreditedToInvoiceId).toBe(invoice.id);
  });

  it('a concurrent atomic credit landing between the read and the write is NOT overwritten (lost update)', async () => {
    const jobId = await seedDepositJob(25000);
    const job = (await jobRepo.findById(tenant.tenantId, jobId))!;
    // `invoice` is the deposit-credit path's earlier in-call read.
    const invoice = await createInvoice(jobId, 100000, 'open');

    // A concurrent payment credit (e.g. a Stripe webhook) lands after that
    // read, before the deposit-credit write.
    const raced = await invoiceRepo.incrementAmountPaidAtomic(
      tenant.tenantId,
      invoice.id,
      30000,
      new Date(),
    );
    expect(raced?.amountPaidCents).toBe(30000);

    const result = await applyDepositCreditToInvoice(
      invoice, // stale snapshot: amountPaidCents = 0
      job,
      invoiceRepo,
      paymentRepo,
      jobRepo,
    );

    // Old behavior wrote 0 + 25000 = 25000 absolutely, dropping the 30000.
    expect(result?.invoice.amountPaidCents).toBe(55000);
    expect(result?.invoice.amountDueCents).toBe(45000);

    const reloaded = await invoiceRepo.findById(tenant.tenantId, invoice.id);
    expect(reloaded?.amountPaidCents).toBe(55000);
    // amount_paid_cents never falls below Σ(active payments).
    const { rows } = await pool.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS sum FROM payments
       WHERE tenant_id = $1 AND invoice_id = $2
         AND status IN ('completed', 'processing') AND reversed_at IS NULL`,
      [tenant.tenantId, invoice.id],
    );
    expect(reloaded!.amountPaidCents).toBeGreaterThanOrEqual(Number(rows[0].sum));
  });

  it('a voided invoice takes no deposit credit — rejected, compensated, deposit released', async () => {
    const jobId = await seedDepositJob(25000);
    const job = (await jobRepo.findById(tenant.tenantId, jobId))!;
    const invoice = await createInvoice(jobId, 100000, 'open');
    // Void lands after the snapshot read, before the deposit-credit write.
    await invoiceRepo.update(tenant.tenantId, invoice.id, {
      status: 'void',
      updatedAt: new Date(),
    });

    await expect(
      applyDepositCreditToInvoice(invoice, job, invoiceRepo, paymentRepo, jobRepo),
    ).rejects.toThrow(/deposit credit .* rejected/i);

    // The dead invoice took no money — void → paid stays structurally
    // impossible at the SQL layer.
    const reloaded = await invoiceRepo.findById(tenant.tenantId, invoice.id);
    expect(reloaded?.status).toBe('void');
    expect(reloaded?.amountPaidCents).toBe(0);

    // The already-inserted deposit payment row is compensated, not orphaned.
    const { rows } = await pool.query<{ status: string; reversal_reason: string | null }>(
      `SELECT status, reversal_reason FROM payments
       WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenant.tenantId, invoice.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].reversal_reason).toBe('credit_rejected');

    // The deposit is released back to the job for a live invoice.
    const afterJob = await jobRepo.findById(tenant.tenantId, jobId);
    expect(afterJob?.depositCreditedToInvoiceId).toBeUndefined();
  });

  it('the SQL balance cap rejects a credit that no longer fits — paid never exceeds total', async () => {
    const jobId = await seedDepositJob(25000);
    const invoice = await createInvoice(jobId, 30000, 'open');

    // A concurrent partial payment shrinks the remaining balance to 20000.
    await invoiceRepo.incrementAmountPaidAtomic(tenant.tenantId, invoice.id, 10000, new Date());

    // The 25000 deposit credit no longer fits: 0 rows matched, null returned.
    const rejected = await invoiceRepo.applyDepositCreditAtomic(
      tenant.tenantId,
      invoice.id,
      25000,
      new Date(),
    );
    expect(rejected).toBeNull();

    const reloaded = await invoiceRepo.findById(tenant.tenantId, invoice.id);
    expect(reloaded?.amountPaidCents).toBe(10000); // never 35000
    expect(reloaded!.amountPaidCents).toBeLessThanOrEqual(reloaded!.totals.totalCents);

    // A credit that DOES fit still applies (guards do not over-reject) and a
    // full cover on an issued invoice flips to 'paid'.
    const applied = await invoiceRepo.applyDepositCreditAtomic(
      tenant.tenantId,
      invoice.id,
      20000,
      new Date(),
    );
    expect(applied?.amountPaidCents).toBe(30000);
    expect(applied?.amountDueCents).toBe(0);
    expect(applied?.status).toBe('paid');
  });
});
