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
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { recordPayment } from '../../src/invoices/payment';
import { reversePayment } from '../../src/payments/payment-service';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — payment reversal is atomic and self-healing', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let otherTenant: { tenantId: string; userId: string };
  let jobId: string;
  let otherTenantJobId: string;

  /** Seed one tenant's customer → location → job chain; returns the job id. */
  async function seedJobChain(
    t: { tenantId: string; userId: string },
    label: string,
  ): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Rev',
      lastName: 'Ersal',
      displayName: 'Rev Ersal',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
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
    const newJobId = crypto.randomUUID();
    await jobRepo.create({
      id: newJobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${label}`,
      summary: 'Reversal job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return newJobId;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    otherTenant = await createTestTenant(pool);

    jobId = await seedJobChain(tenant, 'REV-1');
    otherTenantJobId = await seedJobChain(otherTenant, 'REV-NEIGHBOUR');
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedInvoice(
    number: string,
    totalCents: number,
    t: { tenantId: string; userId: string } = tenant,
    job: string = jobId,
  ): Promise<string> {
    const invoiceId = crypto.randomUUID();
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, totalCents, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: t.tenantId,
      jobId: job,
      invoiceNumber: number,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: t.userId,
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
      undefined,
      undefined,
      auditRepo,
    );

    // Race: reverse p1 (−20000) AND record a fresh 5000 credit (+5000).
    // Both legs write their audit rows through the real PgAuditRepository.
    await Promise.all([
      reversePayment(
        { tenantId: tenant.tenantId, paymentId: p1.id, reason: 'ach_return' },
        invoiceRepo,
        paymentRepo,
        auditRepo,
      ),
      recordPayment(
        { tenantId: tenant.tenantId, invoiceId, amountCents: 5000, method: 'cash', providerReference: 'manual_rev_a_2', processedBy: 'owner' },
        invoiceRepo,
        paymentRepo,
        undefined,
        undefined,
        auditRepo,
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

    // The reversal is on the payment's own audit trail, read back from real
    // Postgres: money that was recorded and then taken back must leave BOTH
    // marks, or the ledger and the timeline disagree.
    const paymentEvents = await auditRepo.findByEntity(tenant.tenantId, 'payment', p1.id);
    const reversals = paymentEvents.filter((e) => e.eventType === 'payment.reversed');
    expect(reversals).toHaveLength(1);
    expect(reversals[0].metadata!.amountCents).toBe(20000);
    expect(reversals[0].metadata!.reason).toBe('ach_return');
    expect(reversals[0].metadata!.paymentId).toBe(p1.id);
    expect(reversals[0].tenantId).toBe(tenant.tenantId);

    // The credit that raced it is on the invoice's trail, unswallowed.
    const invoiceEvents = await auditRepo.findByEntity(tenant.tenantId, 'invoice', invoiceId);
    expect(
      invoiceEvents
        .filter((e) => e.eventType === 'payment.recorded')
        .map((e) => e.metadata!.amountCents)
        .sort((a, b) => (a as number) - (b as number)),
    ).toEqual([5000, 20000]);
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

  it("(d) a neighbour tenant can neither reverse nor be touched by this tenant's reversal", async () => {
    // Two tenants, each with a settled payment on their own invoice.
    const mineInvoiceId = await seedInvoice('INV-REV-D', 10000);
    const { payment: mine } = await recordPayment(
      { tenantId: tenant.tenantId, invoiceId: mineInvoiceId, amountCents: 10000, method: 'credit_card', providerReference: 'pi_rev_d_mine', processedBy: 'owner' },
      invoiceRepo,
      paymentRepo,
      undefined,
      undefined,
      auditRepo,
    );
    const theirInvoiceId = await seedInvoice(
      'INV-REV-D-NEIGHBOUR',
      10000,
      otherTenant,
      otherTenantJobId,
    );
    const { payment: theirs } = await recordPayment(
      { tenantId: otherTenant.tenantId, invoiceId: theirInvoiceId, amountCents: 10000, method: 'credit_card', providerReference: 'pi_rev_d_theirs', processedBy: 'owner' },
      invoiceRepo,
      paymentRepo,
      undefined,
      undefined,
      auditRepo,
    );

    // The neighbour tenant cannot reverse THIS tenant's payment: the atomic
    // flip is tenant-scoped, so the row is simply not there for them. It must
    // surface as "missing" (retryable NotFound), never as a successful flip.
    await expect(
      reversePayment(
        { tenantId: otherTenant.tenantId, paymentId: mine.id, reason: 'dispute' },
        invoiceRepo,
        paymentRepo,
        auditRepo,
      ),
    ).rejects.toThrow(/Payment/);

    // This tenant's money is untouched by that attempt.
    const mineRow = await paymentRepo.findById(tenant.tenantId, mine.id);
    expect(mineRow!.status).toBe('completed');
    expect(mineRow!.reversedAt).toBeNull();
    expect((await invoiceRepo.findById(tenant.tenantId, mineInvoiceId))!.amountPaidCents).toBe(
      10000,
    );

    // Now the neighbour reverses its OWN payment. Only its invoice reopens…
    const reversed = await reversePayment(
      { tenantId: otherTenant.tenantId, paymentId: theirs.id, reason: 'ach_return' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );
    expect(reversed.reversed).toBe(true);
    expect((await invoiceRepo.findById(otherTenant.tenantId, theirInvoiceId))!.status).toBe('open');

    // …this tenant's invoice and payment stay exactly as they were.
    const mineAfter = await invoiceRepo.findById(tenant.tenantId, mineInvoiceId);
    expect(mineAfter!.amountPaidCents).toBe(10000);
    expect(mineAfter!.status).toBe('paid');

    // Audit trails do not cross: the neighbour's reversal is readable only
    // under the neighbour's tenant id, and this tenant's payment carries no
    // reversal event at all.
    expect(
      (await auditRepo.findByEntity(otherTenant.tenantId, 'payment', theirs.id)).filter(
        (e) => e.eventType === 'payment.reversed',
      ),
    ).toHaveLength(1);
    expect(await auditRepo.findByEntity(tenant.tenantId, 'payment', theirs.id)).toEqual([]);
    expect(
      (await auditRepo.findByEntity(tenant.tenantId, 'payment', mine.id)).filter(
        (e) => e.eventType === 'payment.reversed',
      ),
    ).toEqual([]);
  });
});
