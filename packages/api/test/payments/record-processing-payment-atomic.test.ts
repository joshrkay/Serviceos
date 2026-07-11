/**
 * `recordProcessingPayment` (payments/payment-service.ts) must credit the invoice
 * balance ATOMICALLY — the same lost-update fix applied to recordPayment. The old
 * path read amountPaidCents into a JS snapshot and blind-set `snapshot + credit`,
 * so an in-flight ACH `payment_intent.processing` credit racing another
 * legitimate credit clobbered one of them. It now routes through
 * incrementAmountPaidAtomic (single compare-and-derive UPDATE).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository, recordPayment } from '../../src/invoices/payment';
import { recordProcessingPayment } from '../../src/payments/payment-service';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const TENANT = 'tenant-proc-1';
const INVOICE_ID = 'inv-proc-1';

function makeOpenInvoice(totalCents = 30000): Invoice {
  const lineItems = [buildLineItem('li-1', 'Service', 1, totalCents, 1, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-proc-1',
    invoiceNumber: 'INV-PROC-1',
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

describe('recordProcessingPayment atomic credit', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    await invoiceRepo.create(makeOpenInvoice(30000));
  });

  it('credits the invoice in-flight and moves it to partially_paid', async () => {
    const { payment, invoice } = await recordProcessingPayment(
      {
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amountCents: 12000,
        method: 'bank_transfer',
        providerReference: 'pi_ach_proc',
        processedBy: 'stripe_webhook',
      },
      invoiceRepo,
      paymentRepo,
    );
    expect(payment.status).toBe('processing');
    expect(invoice.amountPaidCents).toBe(12000);
    expect(invoice.amountDueCents).toBe(18000);
    expect(invoice.status).toBe('partially_paid');
  });

  it('a processing ACH credit racing a manual cash credit — both apply (no lost update)', async () => {
    const proc = recordProcessingPayment(
      {
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amountCents: 15000,
        method: 'bank_transfer',
        providerReference: 'pi_ach_race',
        processedBy: 'stripe_webhook',
      },
      invoiceRepo,
      paymentRepo,
    );
    const cash = recordPayment(
      {
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amountCents: 10000,
        method: 'cash',
        providerReference: 'manual-cash-race',
        processedBy: 'owner',
      },
      invoiceRepo,
      paymentRepo,
    );
    await Promise.all([proc, cash]);

    const reloaded = await invoiceRepo.findById(TENANT, INVOICE_ID);
    // 15000 + 10000 = 25000 (a lost update would leave 15000 OR 10000).
    expect(reloaded!.amountPaidCents).toBe(25000);
    expect(reloaded!.amountDueCents).toBe(5000);
    expect(reloaded!.status).toBe('partially_paid');
  });

  it('caps the in-flight credit to the remaining balance and marks paid', async () => {
    // Prepay 20000 in cash, then a full-invoice ACH (30000) must only credit the
    // remaining 10000 — never push due negative.
    await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 20000, method: 'cash', providerReference: 'cash-1', processedBy: 'owner' },
      invoiceRepo,
      paymentRepo,
    );
    const { payment, invoice } = await recordProcessingPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 30000, method: 'bank_transfer', providerReference: 'pi_ach_full', processedBy: 'stripe_webhook' },
      invoiceRepo,
      paymentRepo,
    );
    expect(payment.amountCents).toBe(10000); // capped
    expect(invoice.amountPaidCents).toBe(30000);
    expect(invoice.amountDueCents).toBe(0);
    expect(invoice.status).toBe('paid');
  });
});
