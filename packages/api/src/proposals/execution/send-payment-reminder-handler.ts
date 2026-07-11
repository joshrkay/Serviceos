import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { TransactionalCommsService } from '../../notifications/transactional-comms-service';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { sendPaymentReminderPayloadSchema } from '../contracts/send-payment-reminder';

/**
 * Executes an approved `send_payment_reminder` proposal (collections cadence).
 *
 * Delivers an overdue-payment reminder to the customer through the existing
 * Layer-A transactional-comms path (the same send the overdue sweep used to
 * fire directly — now gated behind owner approval). The dunning cadence
 * controls timing/frequency (multi-step); v1 reuses the overdue-notice copy
 * for every step. The step metadata (`stepKey`, `offsetDays`, `channel`) is
 * carried on the payload for the audit trail and future per-step copy.
 *
 * Mirrors the other execution handlers: degrades to a synthetic-id
 * passthrough when no comms service is wired (unit tests that don't exercise
 * delivery), returns a failed ExecutionResult on a delivery error (never
 * throws through), and emits a failure-soft audit event.
 */
export class SendPaymentReminderExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'send_payment_reminder';
  // Awaits transactionalComms.notifyInvoiceOverdue → sendCustomerMessage →
  // delivery provider SMS/email — external network I/O.
  performsExternalIo = true;

  constructor(
    private readonly transactionalComms?: TransactionalCommsService,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(
    proposal: Proposal,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const parsed = sendPaymentReminderPayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Could not determine which invoice to send a payment reminder for.',
      };
    }
    const { invoiceId, stepKey, offsetDays, channel } = parsed.data;

    if (!this.transactionalComms) {
      // Dev wiring without a comms service. Returns the invoice id.
      return { success: true, resultEntityId: invoiceId };
    }

    try {
      await this.transactionalComms.notifyInvoiceOverdue(context.tenantId, invoiceId);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to send payment reminder',
      };
    }

    // Audit emission is failure-soft: a logging failure never unwinds a
    // successful customer send.
    if (this.auditRepo) {
      try {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'system',
            eventType: 'invoice.reminder_sent',
            entityType: 'invoice',
            entityId: invoiceId,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'send_payment_reminder',
              stepKey,
              offsetDays,
              channel,
            },
          }),
        );
      } catch {
        // swallow — audit must never fail the execution
      }
    }

    return { success: true, resultEntityId: invoiceId };
  }
}
