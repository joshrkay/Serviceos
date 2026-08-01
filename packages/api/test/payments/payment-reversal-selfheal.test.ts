/**
 * Crash-recovery self-heal for `reversePayment` (payments/payment-service.ts).
 *
 * The payment flip and the invoice decrement commit as SEPARATE statements on
 * the webhook path. A crash AFTER the flip committed but BEFORE the invoice
 * decrement leaves the invoice OVER-credited (still shows the reversed payment as
 * paid); every later Stripe redelivery then finds the payment already reversed →
 * the atomic flip returns null → the no-op branch. Before the fix that branch
 * returned without reopening the invoice, so it permanently under-collected.
 *
 * We simulate the crash by flipping the payment directly via the repo
 * (reversePaymentAtomic) WITHOUT running reversePayment's invoice decrement, then
 * re-run reversePayment as the redelivery and assert the invoice is reconciled
 * from the active payment ledger.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository, recordPayment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { reversePayment } from '../../src/payments/payment-service';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const TENANT = 'tenant-heal-1';
const INVOICE_ID = 'inv-heal-1';

function makeOpenInvoice(totalCents = 10000): Invoice {
  const lineItems = [buildLineItem('li-1', 'Service', 1, totalCents, 1, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-heal-1',
    invoiceNumber: 'INV-HEAL-1',
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

describe('reversePayment crash-recovery self-heal', () => {
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
        providerReference: 'pi_heal',
        processedBy: 'u1',
      },
      invoiceRepo,
      paymentRepo,
    );
    return payment;
  }

  it('a redelivery after crash-before-decrement reopens the invoice from the ledger', async () => {
    const payment = await setupPaidInvoice(10000);
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('paid');

    // Simulate the crash: the flip committed but the invoice decrement never ran.
    await paymentRepo.reversePaymentAtomic(TENANT, payment.id, {
      reversedAt: new Date(),
      reason: 'ach_return',
    });
    // Invoice is now OVER-credited: payment is failed/reversed but invoice still
    // shows fully paid.
    const stranded = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(stranded?.status).toBe('paid');
    expect(stranded?.amountPaidCents).toBe(10000);

    // Redelivery of the NSF webhook.
    const result = await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'ach_return', correlationId: 'pi_heal' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );

    // The atomic flip was a no-op (already reversed), but the invoice got healed.
    expect(result.reversed).toBe(false);
    const healed = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(healed?.status).toBe('open');
    expect(healed?.amountPaidCents).toBe(0);
    expect(healed?.amountDueCents).toBe(10000);

    // The audit the crashed original attempt never reached is emitted (recovered).
    const events = auditRepo.getAll();
    const reversedEvt = events.find(
      (e) => e.eventType === 'payment.reversed' && e.metadata?.recovered === true,
    );
    expect(reversedEvt).toBeDefined();
    const statusEvt = events.find((e) => e.eventType === 'invoice.status_changed');
    expect(statusEvt?.metadata?.oldStatus).toBe('paid');
    expect(statusEvt?.metadata?.newStatus).toBe('open');
  });

  it('the self-heal is idempotent — a second redelivery does not repair again', async () => {
    const payment = await setupPaidInvoice(10000);
    await paymentRepo.reversePaymentAtomic(TENANT, payment.id, {
      reversedAt: new Date(),
      reason: 'ach_return',
    });

    await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'ach_return' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );
    const auditAfterFirst = auditRepo.getAll().length;

    // Second redelivery: invoice already consistent → reconcile is a no-op, no
    // further audit, no double-decrement.
    const second = await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'ach_return' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );
    expect(second.reversed).toBe(false);
    expect(auditRepo.getAll().length).toBe(auditAfterFirst);
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.amountPaidCents).toBe(0);
    expect(inv?.status).toBe('open');
  });

  it('partial crash-recovery: one of two payments reversed → heals to partially_paid', async () => {
    await invoiceRepo.create(makeOpenInvoice(10000));
    await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 6000, method: 'credit_card', providerReference: 'pi_a', processedBy: 'u1' },
      invoiceRepo,
      paymentRepo,
    );
    const { payment: p2 } = await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 4000, method: 'credit_card', providerReference: 'pi_b', processedBy: 'u1' },
      invoiceRepo,
      paymentRepo,
    );
    // Crash: flip p2 only, no invoice decrement.
    await paymentRepo.reversePaymentAtomic(TENANT, p2.id, { reversedAt: new Date(), reason: 'dispute' });

    await reversePayment(
      { tenantId: TENANT, paymentId: p2.id, reason: 'dispute' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.amountPaidCents).toBe(6000); // only the active p1 remains
    expect(inv?.amountDueCents).toBe(4000);
    expect(inv?.status).toBe('partially_paid');
  });

  it('a normal (non-crashed) duplicate reversal stays a clean no-op with no invoice change', async () => {
    const payment = await setupPaidInvoice(10000);
    // Full, correct reversal via the service (flip + decrement both run).
    await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'ach_return' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );
    const auditAfterFirst = auditRepo.getAll().length;
    const invAfterFirst = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(invAfterFirst?.status).toBe('open');
    expect(invAfterFirst?.amountPaidCents).toBe(0);

    // Duplicate delivery: invoice already consistent → no repair, no extra audit.
    const dup = await reversePayment(
      { tenantId: TENANT, paymentId: payment.id, reason: 'ach_return' },
      invoiceRepo,
      paymentRepo,
      auditRepo,
    );
    expect(dup.reversed).toBe(false);
    expect(auditRepo.getAll().length).toBe(auditAfterFirst);
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.amountPaidCents).toBe(0);
  });
});
