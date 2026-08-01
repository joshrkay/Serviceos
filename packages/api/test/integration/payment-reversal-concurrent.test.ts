/**
 * Postgres integration — reversal must NOT lose an update, and a crash between
 * the payment flip and the invoice decrement must self-heal on redelivery.
 *
 * Two regressions, pinned against real Postgres (a mocked Pool can't prove the
 * single-UPDATE arithmetic or the WHERE guards):
 *
 *  (a) LOST UPDATE — reversePayment used to read amount_paid into a JS snapshot
 *      and blind-set `snapshot − amountCents`. A reversal racing a concurrent
 *      legitimate credit clobbered one write. decrementAmountPaidAtomic /
 *      incrementAmountPaidAtomic derive from the row's own value in one UPDATE,
 *      so both apply.
 *
 *  (b) CRASH-AFTER-FLIP — the flip (reversePaymentAtomic) and the invoice
 *      decrement commit as separate statements. A crash after the flip left the
 *      invoice permanently over-credited, because every redelivery found the
 *      payment already reversed and hit the no-op branch. reversePayment now
 *      reconciles the invoice from the active payment ledger on that branch.
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
import { reversePayment } from '../../src/payments/payment-service';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — payment reversal is atomic and self-healing', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Rev',
      lastName: 'Ersal',
      displayName: 'Rev Ersal',
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
      street1: '1 Reversal Rd',
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
      jobNumber: 'JOB-REV-1',
      summary: 'Reversal job',
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

  async function seedInvoice(number: string, totalCents: number): Promise<string> {
    const invoiceId = crypto.randomUUID();
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, totalCents, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: number,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return invoiceId;
  }

  it('(a) a reversal racing a concurrent credit — both apply, no lost update', async () => {
    const invoiceId = await seedInvoice('INV-REV-A', 30000);

    // Existing 20000 payment → partially_paid, 10000 due.
    const { payment: p1 } = await recordPayment(
      { tenantId: tenant.tenantId, invoiceId, amountCents: 20000, method: 'credit_card', providerReference: 'pi_rev_a_1', processedBy: 'owner' },
      invoiceRepo,
      paymentRepo,
    );

    // Race: reverse p1 (−20000) AND record a fresh 5000 credit (+5000).
    await Promise.all([
      reversePayment(
        { tenantId: tenant.tenantId, paymentId: p1.id, reason: 'ach_return' },
        invoiceRepo,
        paymentRepo,
      ),
      recordPayment(
        { tenantId: tenant.tenantId, invoiceId, amountCents: 5000, method: 'cash', providerReference: 'manual_rev_a_2', processedBy: 'owner' },
        invoiceRepo,
        paymentRepo,
      ),
    ]);

    const reloaded = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    // 20000 − 20000 + 5000 = 5000. A lost update would leave 0 or 25000.
    expect(reloaded!.amountPaidCents).toBe(5000);
    expect(reloaded!.amountDueCents).toBe(25000);
    expect(reloaded!.status).toBe('partially_paid');

    const reversedP1 = await paymentRepo.findById(tenant.tenantId, p1.id);
    expect(reversedP1!.status).toBe('failed');
    expect(reversedP1!.reversedAt).toBeInstanceOf(Date);
  });

  it('(b) a redelivery after a crash-before-decrement reopens the invoice from the ledger', async () => {
    const invoiceId = await seedInvoice('INV-REV-B', 10000);
    const { payment } = await recordPayment(
      { tenantId: tenant.tenantId, invoiceId, amountCents: 10000, method: 'credit_card', providerReference: 'pi_rev_b_1', processedBy: 'owner' },
      invoiceRepo,
      paymentRepo,
    );
    expect((await invoiceRepo.findById(tenant.tenantId, invoiceId))?.status).toBe('paid');

    // Simulate the crash: the payment flip committed, the invoice decrement did
    // NOT run (they are separate statements on the webhook path).
    const flipped = await paymentRepo.reversePaymentAtomic(tenant.tenantId, payment.id, {
      reversedAt: new Date(),
      reason: 'ach_return',
    });
    expect(flipped!.status).toBe('failed');
    const stranded = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(stranded!.status).toBe('paid'); // still over-credited
    expect(stranded!.amountPaidCents).toBe(10000);

    // Redelivery: the atomic flip is now a no-op, but the invoice must self-heal.
    const result = await reversePayment(
      { tenantId: tenant.tenantId, paymentId: payment.id, reason: 'ach_return' },
      invoiceRepo,
      paymentRepo,
    );
    expect(result.reversed).toBe(false);

    const healed = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(healed!.amountPaidCents).toBe(0);
    expect(healed!.amountDueCents).toBe(10000);
    expect(healed!.status).toBe('open');

    // Idempotent: a further redelivery leaves it consistent.
    await reversePayment(
      { tenantId: tenant.tenantId, paymentId: payment.id, reason: 'ach_return' },
      invoiceRepo,
      paymentRepo,
    );
    const again = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(again!.amountPaidCents).toBe(0);
    expect(again!.status).toBe('open');
  });

  it('(c) decrementAmountPaidAtomic clamps at 0 and leaves a terminal invoice untouched', async () => {
    const invoiceId = await seedInvoice('INV-REV-C', 10000);
    const { payment } = await recordPayment(
      { tenantId: tenant.tenantId, invoiceId, amountCents: 4000, method: 'cash', providerReference: 'cash_rev_c', processedBy: 'owner' },
      invoiceRepo,
      paymentRepo,
    );
    // Over-decrement (delta > paid) clamps to 0 / open.
    const decremented = await invoiceRepo.decrementAmountPaidAtomic(
      tenant.tenantId,
      invoiceId,
      9999999,
      new Date(),
    );
    expect(decremented!.amountPaidCents).toBe(0);
    expect(decremented!.amountDueCents).toBe(10000);
    expect(decremented!.status).toBe('open');
    // Silence unused-var lint on payment; its row backs the credit above.
    expect(payment.status).toBe('completed');

    // Move to a terminal status and confirm the guard leaves it untouched.
    await pool.query(
      `UPDATE invoices SET status = 'void' WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenant.tenantId],
    );
    const guarded = await invoiceRepo.decrementAmountPaidAtomic(
      tenant.tenantId,
      invoiceId,
      1000,
      new Date(),
    );
    expect(guarded).toBeNull();
    expect((await invoiceRepo.findById(tenant.tenantId, invoiceId))!.status).toBe('void');
  });
});
