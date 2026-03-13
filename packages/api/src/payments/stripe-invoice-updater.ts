import { recordPayment, RecordPaymentInput, PaymentRepository } from '../invoices/payment';
import { InvoiceRepository, Invoice } from '../invoices/invoice';
import { StripeWebhookResult } from './stripe-webhook-handler';

export interface InvoiceUpdateResult {
  success: boolean;
  invoiceId?: string;
  newStatus?: string;
  error?: string;
}

export async function processStripePaymentEvent(
  event: StripeWebhookResult,
  invoiceRepo: InvoiceRepository,
  paymentRepo: PaymentRepository,
  tenantId: string
): Promise<InvoiceUpdateResult> {
  if (event.eventType !== 'payment_intent.succeeded' && event.eventType !== 'checkout.session.completed') {
    return { success: false, error: `Unhandled event type: ${event.eventType}` };
  }
  if (!event.invoiceId) return { success: false, error: 'No invoiceId in event' };
  if (!event.amountCents || event.amountCents <= 0) return { success: false, error: 'Invalid amount' };

  const invoice = await invoiceRepo.findById(tenantId, event.invoiceId);
  if (!invoice) return { success: false, error: 'Invoice not found' };

  const input: RecordPaymentInput = {
    tenantId,
    invoiceId: event.invoiceId,
    amountCents: Math.min(event.amountCents, invoice.amountDueCents),
    method: 'credit_card',
    providerReference: event.paymentIntentId,
    processedBy: 'stripe-webhook',
  };

  const { invoice: updated } = await recordPayment(input, invoiceRepo, paymentRepo);
  return { success: true, invoiceId: updated.id, newStatus: updated.status };
}
