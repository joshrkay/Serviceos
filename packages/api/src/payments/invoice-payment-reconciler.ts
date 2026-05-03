import { recordPayment, RecordPaymentInput, PaymentRepository, Payment } from '../invoices/payment';
import { InvoiceRepository, Invoice } from '../invoices/invoice';
import { AuditRepository } from '../audit/audit';
import type { SendService } from '../notifications/send-service';
import { notifyPaymentRecorded } from './payment-notifications';

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
  auditRepo?: AuditRepository,
  /**
   * Optional send service. When wired, a customer-facing payment
   * receipt is dispatched after the financial side effect is durable.
   * Receipt failures never roll back the recorded payment.
   */
  sendService?: SendService,
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
    await notifyPaymentRecorded({
      tenantId: input.tenantId,
      payment,
      invoiceBefore: invoice,
      invoiceAfter: updatedInvoice,
      actorId: input.processedBy,
      deps: { auditRepo, sendService },
    });
    return { success: true, payment, invoice: updatedInvoice };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}
