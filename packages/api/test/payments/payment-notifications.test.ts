import { describe, it, expect, beforeEach, vi } from 'vitest';
import { notifyPaymentRecorded } from '../../src/payments/payment-notifications';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Payment } from '../../src/invoices/payment';
import type { Invoice } from '../../src/invoices/invoice';
import type { SendService } from '../../src/notifications/send-service';

const TENANT = 'tenant-notif-1';

function buildPayment(): Payment {
  return {
    id: 'pay-1',
    tenantId: TENANT,
    invoiceId: 'inv-1',
    amountCents: 100000,
    method: 'credit_card',
    status: 'completed',
    receivedAt: new Date(),
    processedBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildInvoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    tenantId: TENANT,
    jobId: 'job-1',
    invoiceNumber: 'INV-0001',
    status: 'paid',
    lineItems: [],
    totals: {
      subtotalCents: 100000,
      taxableSubtotalCents: 100000,
      discountCents: 0,
      taxRateBps: 0,
      taxCents: 0,
      totalCents: 100000,
    },
    amountPaidCents: 100000,
    amountDueCents: 0,
    originatingLeadId: 'lead-1',
    createdBy: 'u',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('notifyPaymentRecorded', () => {
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    auditRepo = new InMemoryAuditRepository();
  });

  it('emits payment.recorded, invoice.status_changed, and invoice.paid when transitioning to paid', async () => {
    await notifyPaymentRecorded({
      tenantId: TENANT,
      payment: buildPayment(),
      invoiceBefore: { status: 'open' },
      invoiceAfter: buildInvoice(),
      actorId: 'user-1',
      deps: { auditRepo },
    });

    const events = await auditRepo.findByEntity(TENANT, 'invoice', 'inv-1');
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['payment.recorded', 'invoice.status_changed', 'invoice.paid'])
    );
    const paid = events.find((e) => e.eventType === 'invoice.paid');
    expect(paid?.metadata).toMatchObject({
      paymentId: 'pay-1',
      totalCents: 100000,
      originatingLeadId: 'lead-1',
    });
  });

  it('does not emit invoice.paid for a partial payment', async () => {
    await notifyPaymentRecorded({
      tenantId: TENANT,
      payment: { ...buildPayment(), amountCents: 30000 },
      invoiceBefore: { status: 'open' },
      invoiceAfter: buildInvoice({ status: 'partially_paid', amountPaidCents: 30000, amountDueCents: 70000 }),
      actorId: 'user-1',
      deps: { auditRepo },
    });
    const events = await auditRepo.findByEntity(TENANT, 'invoice', 'inv-1');
    expect(events.find((e) => e.eventType === 'invoice.paid')).toBeUndefined();
    expect(events.find((e) => e.eventType === 'invoice.status_changed')).toBeDefined();
  });

  it('dispatches a payment receipt via the send service', async () => {
    const sendPaymentReceipt = vi.fn().mockResolvedValue({ channelsSent: [{}], errors: [] });
    const fakeSend = { sendPaymentReceipt } as unknown as SendService;

    await notifyPaymentRecorded({
      tenantId: TENANT,
      payment: buildPayment(),
      invoiceBefore: { status: 'open' },
      invoiceAfter: buildInvoice(),
      actorId: 'user-1',
      deps: { auditRepo, sendService: fakeSend },
    });

    expect(sendPaymentReceipt).toHaveBeenCalledWith({
      tenantId: TENANT,
      payment: expect.objectContaining({ id: 'pay-1' }),
    });
  });

  it('logs payment.receipt_failed when all channels fail', async () => {
    const sendPaymentReceipt = vi.fn().mockResolvedValue({
      channelsSent: [],
      errors: ['sms: nope', 'email: nope'],
    });
    const fakeSend = { sendPaymentReceipt } as unknown as SendService;

    await notifyPaymentRecorded({
      tenantId: TENANT,
      payment: buildPayment(),
      invoiceBefore: { status: 'open' },
      invoiceAfter: buildInvoice(),
      actorId: 'user-1',
      deps: { auditRepo, sendService: fakeSend },
    });

    const events = await auditRepo.findByEntity(TENANT, 'payment', 'pay-1');
    expect(events.find((e) => e.eventType === 'payment.receipt_failed')).toBeDefined();
  });
});
