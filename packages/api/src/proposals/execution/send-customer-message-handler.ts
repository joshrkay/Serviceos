import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { sendCustomerMessagePayloadSchema } from '../contracts/send-customer-message';

/**
 * Structural dependency the execution handler drafts a customer message
 * through. Production wires `TwilioCustomerMessageService`
 * (`notifications/twilio-customer-message-service.ts`), which sends via the
 * SAME `MessageDeliveryProvider` (and its TCPA consent + DNC + kill-switch
 * gates, `notifications/gated-message-delivery.ts`) that
 * `TwilioDelayNotificationService` already uses for delay notices — no new
 * Twilio/SendGrid touchpoint. A gate refusal (no consent, DNC, channel
 * disabled, no phone/email on file) is expected to be a THROWN error, which
 * `execute()` below converts into an honest `{ success: false, error }`
 * rather than a silent success.
 */
export interface CustomerMessengerInput {
  tenantId: string;
  customerId: string;
  channel: 'sms' | 'email';
  body: string;
  subject?: string;
  actorId: string;
}

export interface CustomerMessengerResult {
  dispatched: boolean;
  dispatchId?: string;
}

export interface CustomerMessenger {
  sendCustomMessage(input: CustomerMessengerInput): Promise<CustomerMessengerResult>;
}

/**
 * Executes an approved `send_customer_message` proposal (Tradesperson
 * wave 1, Task 5): a free-form outbound text or email the owner has
 * already read and approved.
 *
 * Comms-class (proposals/proposal.ts actionClassForProposalType) — this
 * only ever runs after explicit owner approval (D3, "Never auto-execute").
 * The AI drafts the exact text (ai/tasks/send-customer-message-task.ts);
 * this handler's ONLY job is to send precisely what was approved, unedited.
 *
 * Follows the house degrade-to-synthetic-id pattern
 * (`NotifyDelayExecutionHandler` / `RecordRefundExecutionHandler`): no
 * `messenger` wired → reports `isFullyWired() === false` and, at execute
 * time, returns a synthetic success id without sending anything (used by
 * in-memory unit tests that don't exercise the send path; boot fails closed
 * when a real pool is configured and this handler is degraded — see
 * `execution/wiring-assertions.ts`).
 *
 * Emits `customer_message.sent` (entityType `customer`) for operational
 * traceability, carrying `proposalId`/`channel`/`dispatchId` when the
 * messenger returns one. Deliberately NOT added to
 * `analytics/audit-event-mapping.ts` — there is no pre-existing mapped
 * event for a generic outbound message the way `payment.refunded` exists
 * for refunds, so this event is the sole record and stays out of the
 * product-analytics mapping, matching `refund.recorded`/`credit.applied`'s
 * unmapped-by-design posture.
 */
export class SendCustomerMessageExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'send_customer_message';
  // Awaits messenger.sendCustomMessage — outbound customer SMS/email via the
  // delivery provider. Read-only on the DB otherwise (no domain mutation).
  performsExternalIo = true;

  constructor(
    private readonly messenger?: CustomerMessenger,
    private readonly auditRepo?: AuditRepository,
  ) {}

  isFullyWired(): boolean {
    return Boolean(this.messenger);
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = sendCustomerMessagePayloadSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Could not determine the customer message to send (missing customer, channel, or message body).',
      };
    }
    const { customerId, channel, body, subject } = parsed.data;

    if (!this.messenger) {
      // Dev/test wiring without a messenger — degrade to synthetic
      // passthrough. Mirrors NotifyDelayExecutionHandler / RecordRefundExecutionHandler.
      return { success: true, resultEntityId: uuidv4() };
    }

    try {
      const result = await this.messenger.sendCustomMessage({
        tenantId: context.tenantId,
        customerId,
        channel,
        body,
        ...(subject ? { subject } : {}),
        actorId: context.executedBy,
      });

      if (this.auditRepo) {
        try {
          await this.auditRepo.create(
            createAuditEvent({
              tenantId: context.tenantId,
              actorId: context.executedBy,
              actorRole: 'voice_agent',
              eventType: 'customer_message.sent',
              entityType: 'customer',
              entityId: customerId,
              metadata: {
                proposalId: proposal.id,
                channel,
                ...(result.dispatchId ? { dispatchId: result.dispatchId } : {}),
              },
            }),
          );
        } catch (auditErr) {
          // Audit failures must not unwind a successful send — but they
          // must be diagnosable. Mirrors RecordRefundExecutionHandler.
          const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
          console.warn(
            `Failed to emit customer_message.sent audit event for customer ${customerId} (proposal ${proposal.id}): ${msg}`,
          );
        }
      }

      return { success: true, resultEntityId: customerId };
    } catch (err) {
      // Surfaces the delivery layer's refusal (TCPA/consent gate, DNC,
      // channel kill switch, no phone/email on file) as an honest failure —
      // never a silent success. Mirrors NotifyDelayExecutionHandler.
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
