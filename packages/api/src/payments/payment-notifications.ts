/**
 * Post-payment-recorded side effects — invoice.paid audit event and
 * customer-facing receipt.
 *
 * Lives outside the recordPayment / reconcilePayment data path because
 * notification failures must NEVER block payment recording. Callers
 * await this after the financial side effect is durable, so a receipt
 * outage doesn't roll back a settled payment.
 */
import type { Payment } from '../invoices/payment';
import type { Invoice, InvoiceStatus } from '../invoices/invoice';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import type { SendService } from '../notifications/send-service';

export interface PaymentNotificationDeps {
  auditRepo?: AuditRepository;
  sendService?: SendService;
}

export async function notifyPaymentRecorded(args: {
  tenantId: string;
  payment: Payment;
  /** Invoice state BEFORE this payment, so callers can detect status transitions. */
  invoiceBefore: Pick<Invoice, 'status'>;
  /** Invoice state AFTER this payment. */
  invoiceAfter: Invoice;
  actorId: string;
  deps: PaymentNotificationDeps;
}): Promise<void> {
  const { tenantId, payment, invoiceBefore, invoiceAfter, actorId, deps } = args;

  if (deps.auditRepo) {
    const transitioned: InvoiceStatus | null =
      invoiceAfter.status !== invoiceBefore.status ? invoiceAfter.status : null;

    await deps.auditRepo
      .create(
        createAuditEvent({
          tenantId,
          actorId,
          actorRole: 'system',
          eventType: 'payment.recorded',
          entityType: 'invoice',
          entityId: invoiceAfter.id,
          metadata: {
            paymentId: payment.id,
            amountCents: payment.amountCents,
            method: payment.method,
            newInvoiceStatus: invoiceAfter.status,
          },
        })
      )
      .catch(() => {
        // Audit failure must not abort downstream notifications.
      });

    if (transitioned) {
      await deps.auditRepo
        .create(
          createAuditEvent({
            tenantId,
            actorId,
            actorRole: 'system',
            eventType: 'invoice.status_changed',
            entityType: 'invoice',
            entityId: invoiceAfter.id,
            metadata: {
              oldStatus: invoiceBefore.status,
              newStatus: invoiceAfter.status,
              paymentId: payment.id,
            },
          })
        )
        .catch(() => {});
    }

    if (transitioned === 'paid') {
      await deps.auditRepo
        .create(
          createAuditEvent({
            tenantId,
            actorId,
            actorRole: 'system',
            eventType: 'invoice.paid',
            entityType: 'invoice',
            entityId: invoiceAfter.id,
            metadata: {
              paymentId: payment.id,
              totalCents: invoiceAfter.totals.totalCents,
              originatingLeadId: invoiceAfter.originatingLeadId,
            },
          })
        )
        .catch(() => {});
    }
  }

  if (deps.sendService) {
    const receipt = await deps.sendService
      .sendPaymentReceipt({ tenantId, payment })
      .catch((err) => ({
        channelsSent: [],
        errors: [err instanceof Error ? err.message : 'unknown error'],
      }));

    if (deps.auditRepo && receipt.channelsSent.length === 0 && receipt.errors.length > 0) {
      await deps.auditRepo
        .create(
          createAuditEvent({
            tenantId,
            actorId,
            actorRole: 'system',
            eventType: 'payment.receipt_failed',
            entityType: 'payment',
            entityId: payment.id,
            metadata: { errors: receipt.errors },
          })
        )
        .catch(() => {});
    }
  }
}
