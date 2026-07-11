/**
 * Invoice-to-cash failure handling — service-layer tests for
 * `reversePayment` and `recordFailedPaymentAttempt` (payments/payment-service.ts).
 *
 * A REVERSAL is the inverse of recordPayment: it marks money that never
 * truly settled (ACH/bank NSF return) or was clawed back (card chargeback),
 * flipping the payment to 'failed' and REOPENING the invoice so it
 * re-enters collections. The route-level wiring is covered by
 * test/webhooks/stripe-payment-events.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryInvoiceRepository,
  Invoice,
  transitionInvoiceStatus,
} from '../../src/invoices/invoice';
import { InMemoryPaymentRepository, recordPayment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { reversePayment, recordFailedPaymentAttempt } from '../../src/payments/payment-service';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { NotFoundError } from '../../src/shared/errors';

const TENANT = 'tenant-rev-1';
const INVOICE_ID = 'inv-rev-1';

function makeOpenInvoice(totalCents = 10000): Invoice {
  const lineItems = [buildLineItem('li-1', 'Service', 1, totalCents, 1, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-rev-1',
    invoiceNumber: 'INV-REV-1',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('reversePayment', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  async function setupPaidInvoice(totalCents = 10000) {
    await invoiceRepo.create(makeOpenInvoice(totalCents));
    const { payment } = await recordPayment(
      {
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amountCents: totalCents,
        method: 'credit_card',
        providerReference: 'pi_test',
        processedBy: 'u1',
      },
      invoiceRepo,
      paymentRepo,
    );
    return payment;
  }

  it('reverses a full payment → invoice reopens to open with the balance restored', async () => {
    const payment = await setupPaidInvoice(10000);
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('paid');

    const result = await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'ach_return' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );

    expect(result.reversed).toBe(true);
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);
    expect(inv?.amountDueCents).toBe(10000);

    const reversed = await paymentRepo.findById(TENANT, payment.id);
    expect(reversed?.status).toBe('failed');
    expect(reversed?.reversedAt).toBeInstanceOf(Date);
    expect(reversed?.reversalReason).toBe('ach_return');
  });

  it('reverses one of two payments → invoice drops back to partially_paid', async () => {
    await invoiceRepo.create(makeOpenInvoice(10000));
    await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 6000, method: 'credit_card', providerReference: 'pi_1', processedBy: 'u1' },
      invoiceRepo,
      paymentRepo,
    );
    const { payment: p2 } = await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 4000, method: 'credit_card', providerReference: 'pi_2', processedBy: 'u1' },
      invoiceRepo,
      paymentRepo,
    );
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('paid');

    await reversePayment(
      { tenantId: TENANT, paymentId: p2.id, reason: 'dispute' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('partially_paid');
    expect(inv?.amountPaidCents).toBe(6000);
    expect(inv?.amountDueCents).toBe(4000);
  });

  it('is idempotent — a duplicate reversal is a no-op and does not double-decrement', async () => {
    const payment = await setupPaidInvoice(10000);
    const first = await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'ach_return' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );
    const second = await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'ach_return' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );

    expect(first.reversed).toBe(true);
    expect(second.reversed).toBe(false);
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);
  });

  it('throws NotFoundError for a missing payment (retryable webhook race)', async () => {
    await expect(
      reversePayment(
        { tenantId: TENANT, paymentId: 'does-not-exist', reason: 'dispute' },
        invoiceRepo,
        paymentRepo,
        auditRepo,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('isolates tenants — cannot reverse another tenant’s payment', async () => {
    const payment = await setupPaidInvoice(10000);
    await expect(
      reversePayment(
        { tenantId: 'other-tenant', paymentId: payment.id, reason: 'dispute' },
        invoiceRepo,
        paymentRepo,
        auditRepo,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('paid');
  });

  it('emits payment.reversed + invoice.status_changed audit events', async () => {
    const payment = await setupPaidInvoice(10000);
    await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'ach_return', correlationId: 'pi_test' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );

    const events = auditRepo.getAll();
    expect(events.find((e) => e.eventType === 'payment.reversed')).toBeDefined();
    const statusChange = events.find((e) => e.eventType === 'invoice.status_changed');
    expect(statusChange?.metadata?.oldStatus).toBe('paid');
    expect(statusChange?.metadata?.newStatus).toBe('open');
  });

  it('flips the payment but leaves a terminal (void) invoice untouched', async () => {
    await invoiceRepo.create(makeOpenInvoice(10000));
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 6000, method: 'credit_card', providerReference: 'pi_v', processedBy: 'u1' },
      invoiceRepo,
      paymentRepo,
    );
    await transitionInvoiceStatus(TENANT, INVOICE_ID, 'void', invoiceRepo);

    const result = await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'dispute' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );

    expect(result.reversed).toBe(true);
    expect((await paymentRepo.findById(TENANT, payment.id))?.status).toBe('failed');
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('void');
  });

  // TEST-01/03 — refund/reversal on an already-closed invoice must never
  // double-mutate. A second dispute/NSF-return webhook for the SAME
  // payment on a void invoice (e.g. a redelivered charge.dispute.created,
  // or an unrelated ach_return arriving after the chargeback already
  // reversed it) is a clean no-op: the atomic flip guard rejects the
  // second reversal, and — because reconcileInvoiceAfterReversal's
  // reduce-only guard sees the ledger already matches amount_paid — no
  // repair audit fires either. The invoice must never go negative.
  it('a SECOND reversal attempt on an already-reversed payment tied to a closed invoice is a clean no-op — no negative balance, no duplicate audit', async () => {
    await invoiceRepo.create(makeOpenInvoice(10000));
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 6000, method: 'credit_card', providerReference: 'pi_double_rev', processedBy: 'u1' },
      invoiceRepo,
      paymentRepo,
    );
    await transitionInvoiceStatus(TENANT, INVOICE_ID, 'void', invoiceRepo);

    const first = await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'dispute', correlationId: 'disp_1' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );
    expect(first.reversed).toBe(true);
    const afterFirst = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(afterFirst?.status).toBe('void');
    expect(afterFirst?.amountPaidCents).toBe(6000); // untouched — terminal invoice
    const auditCountAfterFirst = auditRepo.getAll().length;

    // Second delivery for the SAME payment (double-reversal attempt).
    const second = await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'dispute', correlationId: 'disp_1_retry' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );

    expect(second.reversed).toBe(false);
    const afterSecond = await invoiceRepo.findById(TENANT, INVOICE_ID);
    // Never negative, never double-decremented — still exactly what it was
    // after the first (and only) real reversal.
    expect(afterSecond?.amountPaidCents).toBe(6000);
    expect(afterSecond?.amountDueCents).toBeGreaterThanOrEqual(0);
    expect(afterSecond?.status).toBe('void');
    // No repair was needed (ledger already matched amount_paid), so no
    // extra audit event — the skip/no-op leaves no trace beyond the one
    // real reversal's audit trail.
    expect(auditRepo.getAll().length).toBe(auditCountAfterFirst);
    expect((await paymentRepo.findById(TENANT, payment.id))?.status).toBe('failed');
  });
});

describe('recordFailedPaymentAttempt', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeOpenInvoice(10000));
  });

  it('records a failed row for visibility without changing the invoice balance', async () => {
    const payment = await recordFailedPaymentAttempt(
      {
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amountCents: 10000,
        method: 'credit_card',
        providerReference: 'pi_decline',
        reason: 'card_declined',
      },
      paymentRepo,
      auditRepo,
    );

    expect(payment.status).toBe('failed');
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);
    expect(inv?.amountDueCents).toBe(10000);
    expect(auditRepo.getAll().find((e) => e.eventType === 'payment.failed')).toBeDefined();
  });
});
