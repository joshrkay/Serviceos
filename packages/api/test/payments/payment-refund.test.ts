/**
 * D2-4 — partial-refund tracking on payments.
 *
 * recordRefund() is the sole allowed mutation path for refund tracking
 * (direct paymentRepo.update bypasses the over-refund guard and skips
 * the audit event). These tests pin the invariants down so future
 * refactors can't regress them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { recordRefund } from '../../src/payments/payment-service';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { ValidationError } from '../../src/shared/errors';

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';

function makePayment(over: Partial<Payment> = {}): Payment {
  const now = new Date('2026-05-01T12:00:00Z');
  return {
    id: uuidv4(),
    tenantId: TENANT_A,
    invoiceId: 'inv-1',
    amountCents: 50000,
    method: 'credit_card',
    status: 'completed',
    receivedAt: now,
    processedBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    ...over,
  };
}

describe('recordRefund (D2-4)', () => {
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('happy path: records a partial refund, sets refundedAt + stripe id, emits audit', async () => {
    const payment = makePayment({ amountCents: 50000 });
    await paymentRepo.create(payment);

    const refundedAt = new Date('2026-05-10T15:30:00Z');
    const result = await recordRefund(
      {
        tenantId: TENANT_A,
        paymentId: payment.id,
        refundCents: 5000,
        stripeRefundId: 're_test_001',
        refundedAt,
      },
      paymentRepo,
      auditRepo,
    );

    expect(result.refundCents).toBe(5000);
    expect(result.totalRefundedCents).toBe(5000);

    const reread = await paymentRepo.findById(TENANT_A, payment.id);
    expect(reread?.refundedAmountCents).toBe(5000);
    expect(reread?.refundedAt?.toISOString()).toBe(refundedAt.toISOString());
    expect(reread?.lastRefundStripeId).toBe('re_test_001');
    // The original payment row keeps its FULL magnitude — refund is a
    // separate accumulator, not a status flip.
    expect(reread?.amountCents).toBe(50000);
    expect(reread?.status).toBe('completed');

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('payment.refunded');
    expect(events[0].entityType).toBe('payment');
    expect(events[0].entityId).toBe(payment.id);
    expect(events[0].metadata).toMatchObject({
      paymentId: payment.id,
      refundCents: 5000,
      totalRefundedCents: 5000,
      stripeRefundId: 're_test_001',
    });
  });

  it('rejects over-refund (refund + previously refunded > amountCents)', async () => {
    const payment = makePayment({
      amountCents: 50000,
      refundedAmountCents: 40000,
      refundedAt: new Date('2026-05-05T00:00:00Z'),
    });
    await paymentRepo.create(payment);

    await expect(
      recordRefund(
        {
          tenantId: TENANT_A,
          paymentId: payment.id,
          refundCents: 15000, // 40000 + 15000 = 55000 > 50000
        },
        paymentRepo,
        auditRepo,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // Refund was rejected — no audit event, no state change.
    const reread = await paymentRepo.findById(TENANT_A, payment.id);
    expect(reread?.refundedAmountCents).toBe(40000);
    expect(auditRepo.getAll()).toHaveLength(0);
  });

  it('rejects refund of exactly $0.01 over the original (boundary)', async () => {
    const payment = makePayment({ amountCents: 50000 });
    await paymentRepo.create(payment);

    await expect(
      recordRefund(
        { tenantId: TENANT_A, paymentId: payment.id, refundCents: 50001 },
        paymentRepo,
        auditRepo,
      ),
    ).rejects.toThrow(/exceeds original/i);

    // Exactly the original amount is allowed (full refund).
    const ok = await recordRefund(
      { tenantId: TENANT_A, paymentId: payment.id, refundCents: 50000 },
      paymentRepo,
      auditRepo,
    );
    expect(ok.totalRefundedCents).toBe(50000);
  });

  it('cross-tenant lookup is rejected (tenant B cannot refund tenant A payment)', async () => {
    const payment = makePayment({ tenantId: TENANT_A, amountCents: 50000 });
    await paymentRepo.create(payment);

    await expect(
      recordRefund(
        { tenantId: TENANT_B, paymentId: payment.id, refundCents: 1000 },
        paymentRepo,
        auditRepo,
      ),
    ).rejects.toThrow(/not found/i);

    // The actual payment (tenant A) is untouched.
    const reread = await paymentRepo.findById(TENANT_A, payment.id);
    expect(reread?.refundedAmountCents).toBe(0);
    expect(auditRepo.getAll()).toHaveLength(0);
  });

  it('multi-partial-refund accumulates refundedAmountCents and updates timestamp/stripe id each time', async () => {
    const payment = makePayment({ amountCents: 50000 });
    await paymentRepo.create(payment);

    const t1 = new Date('2026-05-10T00:00:00Z');
    const t2 = new Date('2026-05-15T00:00:00Z');
    const t3 = new Date('2026-05-20T00:00:00Z');

    const r1 = await recordRefund(
      { tenantId: TENANT_A, paymentId: payment.id, refundCents: 5000, stripeRefundId: 're_1', refundedAt: t1 },
      paymentRepo,
      auditRepo,
    );
    expect(r1.totalRefundedCents).toBe(5000);

    const r2 = await recordRefund(
      { tenantId: TENANT_A, paymentId: payment.id, refundCents: 10000, stripeRefundId: 're_2', refundedAt: t2 },
      paymentRepo,
      auditRepo,
    );
    expect(r2.totalRefundedCents).toBe(15000);

    const r3 = await recordRefund(
      { tenantId: TENANT_A, paymentId: payment.id, refundCents: 35000, stripeRefundId: 're_3', refundedAt: t3 },
      paymentRepo,
      auditRepo,
    );
    expect(r3.totalRefundedCents).toBe(50000);

    const reread = await paymentRepo.findById(TENANT_A, payment.id);
    expect(reread?.refundedAmountCents).toBe(50000);
    // The "last" timestamp + stripe id reflect the MOST RECENT refund —
    // the audit log preserves the per-event history.
    expect(reread?.refundedAt?.toISOString()).toBe(t3.toISOString());
    expect(reread?.lastRefundStripeId).toBe('re_3');

    const events = auditRepo.getAll();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.metadata?.totalRefundedCents)).toEqual([5000, 15000, 50000]);
    expect(events.map((e) => e.metadata?.refundCents)).toEqual([5000, 10000, 35000]);
  });

  it('rejects non-positive or non-integer refundCents', async () => {
    const payment = makePayment({ amountCents: 50000 });
    await paymentRepo.create(payment);

    for (const bad of [0, -100, 1.5, NaN]) {
      await expect(
        recordRefund(
          { tenantId: TENANT_A, paymentId: payment.id, refundCents: bad },
          paymentRepo,
          auditRepo,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    }

    const reread = await paymentRepo.findById(TENANT_A, payment.id);
    expect(reread?.refundedAmountCents).toBe(0);
  });

  it('missing paymentId returns the same not-found error as cross-tenant', async () => {
    await expect(
      recordRefund(
        { tenantId: TENANT_A, paymentId: 'does-not-exist', refundCents: 100 },
        paymentRepo,
        auditRepo,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('audit event is optional (auditRepo undefined still completes the mutation)', async () => {
    const payment = makePayment({ amountCents: 50000 });
    await paymentRepo.create(payment);

    const result = await recordRefund(
      { tenantId: TENANT_A, paymentId: payment.id, refundCents: 1234 },
      paymentRepo,
    );
    expect(result.totalRefundedCents).toBe(1234);

    const reread = await paymentRepo.findById(TENANT_A, payment.id);
    expect(reread?.refundedAmountCents).toBe(1234);
  });
});
