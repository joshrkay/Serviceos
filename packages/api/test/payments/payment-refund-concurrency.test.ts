/**
 * D2-4 fix — concurrent-webhook race on `recordRefund`.
 *
 * Stripe can deliver two `charge.refunded` events for the same payment
 * close to simultaneously (retries, dashboard-issued refunds, partials
 * fanned across instances). The original implementation read the
 * payment, validated `previousRefunded + delta <= amountCents`, then
 * UPDATEd — letting two callers both pass the snapshot check and then
 * both write, over-refunding by up to 2x.
 *
 * The fix moves the over-refund guard into the WHERE clause of a
 * single UPDATE statement (`refunded_amount_cents + $delta <=
 * amount_cents`). Whichever statement commits first wins; the second
 * sees the new total and the predicate fails, returning 0 rows.
 *
 * This test fires two `recordRefund` calls via `Promise.all` with
 * amounts that individually pass but together exceed, and asserts:
 *   1. exactly one Promise resolves
 *   2. exactly one Promise rejects with the over-refund ValidationError
 *   3. the persisted `refundedAmountCents` equals the winning refund
 *      (NOT the sum — no over-refund occurred).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { recordRefund } from '../../src/payments/payment-service';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { ValidationError } from '../../src/shared/errors';

const TENANT_A = 'tenant-A';

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

describe('recordRefund — concurrent-webhook race (D2-4 fix)', () => {
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('two concurrent recordRefund calls cannot both succeed when their sum exceeds amountCents', async () => {
    // amountCents=50000; two refunds of 30000 each individually pass
    // the previous-snapshot check (0 + 30000 <= 50000) but together
    // sum to 60000 > 50000. Pre-fix: both writes go through. Post-fix:
    // exactly one wins.
    const payment = makePayment({ amountCents: 50000 });
    await paymentRepo.create(payment);

    const results = await Promise.allSettled([
      recordRefund(
        {
          tenantId: TENANT_A,
          paymentId: payment.id,
          refundCents: 30000,
          stripeRefundId: 're_A',
          refundedAt: new Date('2026-05-10T00:00:00Z'),
        },
        paymentRepo,
        auditRepo,
      ),
      recordRefund(
        {
          tenantId: TENANT_A,
          paymentId: payment.id,
          refundCents: 30000,
          stripeRefundId: 're_B',
          refundedAt: new Date('2026-05-10T00:00:00Z'),
        },
        paymentRepo,
        auditRepo,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(ValidationError);
    expect(String(rejection.reason)).toMatch(/exceeds original payment/i);

    // The persisted total reflects the SINGLE winner, not the sum.
    const reread = await paymentRepo.findById(TENANT_A, payment.id);
    expect(reread?.refundedAmountCents).toBe(30000);

    // Audit log records only the successful refund — the rejected one
    // never gets to the audit step.
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].metadata?.totalRefundedCents).toBe(30000);
  });

  it('two concurrent refunds that together exactly equal amountCents both succeed', async () => {
    // Boundary: 20000 + 30000 = 50000 == amountCents. The guard is
    // `<= amount_cents` (not strict <), so both writes are legitimate
    // and both must commit regardless of ordering.
    const payment = makePayment({ amountCents: 50000 });
    await paymentRepo.create(payment);

    const results = await Promise.allSettled([
      recordRefund(
        { tenantId: TENANT_A, paymentId: payment.id, refundCents: 20000, stripeRefundId: 're_A' },
        paymentRepo,
        auditRepo,
      ),
      recordRefund(
        { tenantId: TENANT_A, paymentId: payment.id, refundCents: 30000, stripeRefundId: 're_B' },
        paymentRepo,
        auditRepo,
      ),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const reread = await paymentRepo.findById(TENANT_A, payment.id);
    expect(reread?.refundedAmountCents).toBe(50000);
    expect(auditRepo.getAll()).toHaveLength(2);
  });
});
