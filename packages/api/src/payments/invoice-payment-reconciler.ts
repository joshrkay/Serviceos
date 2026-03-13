import { recordPayment, RecordPaymentInput, PaymentRepository, Payment } from '../invoices/payment';
import { InvoiceRepository, Invoice } from '../invoices/invoice';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export interface ReconciliationResult {
  success: boolean;
  payment?: Payment;
  invoice?: Invoice;
  error?: string;
}

export async function reconcilePayment(
  input: RecordPaymentInput,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository,
  auditRepo?: AuditRepository
): Promise<ReconciliationResult> {
  // Validate invoice exists
  const invoice = await invoiceRepo.findById(input.tenantId, input.invoiceId);
  if (!invoice) return { success: false, error: 'Invoice not found' };

  // Validate no overpayment
  if (input.amountCents > invoice.amountDueCents) {
    return { success: false, error: 'Payment amount exceeds amount due' };
  }

  // Check payable status
  if (!['open', 'partially_paid'].includes(invoice.status)) {
    return { success: false, error: `Cannot record payment on invoice with status '${invoice.status}'` };
  }

  try {
    const { payment, invoice: updatedInvoice } = await recordPayment(input, invoiceRepo, paymentRepo);

    // Emit audit event if repo provided
    if (auditRepo) {
      const event = createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.processedBy,
        actorRole: 'system',
        eventType: 'payment.recorded',
        entityType: 'invoice',
        entityId: input.invoiceId,
        metadata: {
          paymentId: payment.id,
          amountCents: payment.amountCents,
          method: payment.method,
          newInvoiceStatus: updatedInvoice.status,
        },
      });
      await auditRepo.create(event);

      if (updatedInvoice.status !== invoice.status) {
        const statusEvent = createAuditEvent({
          tenantId: input.tenantId,
          actorId: input.processedBy,
          actorRole: 'system',
          eventType: 'invoice.status_changed',
          entityType: 'invoice',
          entityId: input.invoiceId,
          metadata: {
            oldStatus: invoice.status,
            newStatus: updatedInvoice.status,
            paymentId: payment.id,
          },
        });
        await auditRepo.create(statusEvent);
      }
    }

    return { success: true, payment, invoice: updatedInvoice };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}
