import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordPayment,
  refundPayment,
  InMemoryPaymentRepository,
} from '../../src/invoices/payment';
import {
  InMemoryInvoiceRepository,
  Invoice,
} from '../../src/invoices/invoice';
import { ValidationError } from '../../src/shared/errors';

const TENANT = 'tenant-refund-1';
const USER = 'user-refund-1';

function buildInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    tenantId: TENANT,
    jobId: 'job-1',
    invoiceNumber: 'INV-0001',
    status: 'open',
    lineItems: [],
    totals: {
      subtotalCents: 100000,
      taxableSubtotalCents: 100000,
      discountCents: 0,
      taxRateBps: 0,
      taxCents: 0,
      totalCents: 100000,
    },
    amountPaidCents: 0,
    amountDueCents: 100000,
    createdBy: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('refundPayment', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    await invoiceRepo.create(buildInvoice());
  });

  it('records a full refund as a negative payment and flips invoice back to open', async () => {
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId: 'inv-1', amountCents: 100000, method: 'credit_card', processedBy: USER },
      invoiceRepo,
      paymentRepo,
    );
    const invoiceAfterPay = await invoiceRepo.findById(TENANT, 'inv-1');
    expect(invoiceAfterPay?.status).toBe('paid');

    const { refund, invoice } = await refundPayment(
      { tenantId: TENANT, paymentId: payment.id, amountCents: 100000, reason: 'Service not delivered', processedBy: USER },
      invoiceRepo,
      paymentRepo,
    );

    expect(refund.amountCents).toBe(-100000);
    expect(refund.refundsPaymentId).toBe(payment.id);
    expect(refund.note).toBe('Service not delivered');
    expect(invoice.status).toBe('open');
    expect(invoice.amountPaidCents).toBe(0);
    expect(invoice.amountDueCents).toBe(100000);

    const original = await paymentRepo.findById(TENANT, payment.id);
    expect(original?.status).toBe('refunded');
  });

  it('records a partial refund and flips paid invoice back to partially_paid', async () => {
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId: 'inv-1', amountCents: 100000, method: 'credit_card', processedBy: USER },
      invoiceRepo,
      paymentRepo,
    );

    const { invoice } = await refundPayment(
      { tenantId: TENANT, paymentId: payment.id, amountCents: 30000, reason: 'Adjustment', processedBy: USER },
      invoiceRepo,
      paymentRepo,
    );

    expect(invoice.status).toBe('partially_paid');
    expect(invoice.amountPaidCents).toBe(70000);
    expect(invoice.amountDueCents).toBe(30000);

    // Original is still 'completed' because cumulative refunds < original.
    const original = await paymentRepo.findById(TENANT, payment.id);
    expect(original?.status).toBe('completed');
  });

  it('rejects a refund larger than the amount paid', async () => {
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId: 'inv-1', amountCents: 50000, method: 'credit_card', processedBy: USER },
      invoiceRepo,
      paymentRepo,
    );

    await expect(
      refundPayment(
        { tenantId: TENANT, paymentId: payment.id, amountCents: 60000, reason: 'too much', processedBy: USER },
        invoiceRepo,
        paymentRepo,
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a refund of a refund', async () => {
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId: 'inv-1', amountCents: 100000, method: 'credit_card', processedBy: USER },
      invoiceRepo,
      paymentRepo,
    );
    const { refund } = await refundPayment(
      { tenantId: TENANT, paymentId: payment.id, amountCents: 100000, reason: 'r1', processedBy: USER },
      invoiceRepo,
      paymentRepo,
    );

    await expect(
      refundPayment(
        { tenantId: TENANT, paymentId: refund.id, amountCents: 50000, reason: 'r2', processedBy: USER },
        invoiceRepo,
        paymentRepo,
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires a non-empty reason', async () => {
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId: 'inv-1', amountCents: 100000, method: 'credit_card', processedBy: USER },
      invoiceRepo,
      paymentRepo,
    );

    await expect(
      refundPayment(
        { tenantId: TENANT, paymentId: payment.id, amountCents: 100000, reason: '   ', processedBy: USER },
        invoiceRepo,
        paymentRepo,
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
