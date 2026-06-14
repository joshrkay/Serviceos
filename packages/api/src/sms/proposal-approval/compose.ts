/**
 * P2-034 — SMS one-tap proposal approval: outbound composer.
 *
 * `sendProposalApprovalRequest` is the reusable primitive a notification
 * trigger calls when a proposal lands in `ready_for_review` and the
 * tenant routes approvals to the owner's phone. It:
 *   1. mints a short code and stamps it on the proposal's sourceContext
 *      (Tier-2-safe metadata — no schema migration),
 *   2. texts the owner a one-tap "YES <code> / NO <code>" request,
 *   3. audits the send.
 *
 * Kept separate from the inbound handler so the send path is independently
 * testable and so the trigger (which decides WHEN to notify) stays a thin
 * caller. Best-effort: a send/persist failure is reported, never thrown
 * into the proposal-creation path.
 */
import { Proposal, ProposalRepository } from '../../proposals/proposal';
import { MessageDeliveryProvider } from '../../notifications/delivery-provider';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { createLogger } from '../../logging/logger';
import { generateApprovalCode, renderApprovalRequestSms, smsApprovalCodeOf } from './render';

const logger = createLogger({
  service: 'sms-proposal-approval-compose',
  environment: process.env.NODE_ENV || 'dev',
});

export interface SendApprovalRequestDeps {
  proposalRepo: ProposalRepository;
  messageDelivery: MessageDeliveryProvider;
  auditRepo?: AuditRepository;
  /** Override the code generator for deterministic tests. */
  generateCode?: () => string;
}

export interface SendApprovalRequestInput {
  proposal: Proposal;
  /** The owner's verified E.164 mobile. */
  recipientE164: string;
  /** The owner's user id — bound to the stamped code for traceability. */
  recipientUserId: string;
}

export type SendApprovalRequestResult =
  | { sent: true; code: string; providerMessageId: string }
  | { sent: false; reason: 'already_sent' | 'send_failed'; code?: string };

/**
 * Stamp an approval code on a proposal and text the owner a one-tap
 * approve/decline request. Idempotent: if the proposal already carries an
 * smsApproval code we do not re-text (the inbound webhook dedupes replies;
 * this dedupes sends).
 */
export async function sendProposalApprovalRequest(
  input: SendApprovalRequestInput,
  deps: SendApprovalRequestDeps,
): Promise<SendApprovalRequestResult> {
  const { proposal, recipientE164, recipientUserId } = input;

  const existing = smsApprovalCodeOf(proposal);
  if (existing) {
    return { sent: false, reason: 'already_sent', code: existing };
  }

  const code = (deps.generateCode ?? generateApprovalCode)();

  // Stamp first so an inbound reply can always resolve the code even if
  // the send's provider ack is slow. Rides sourceContext (no migration).
  const stampedContext = {
    ...(proposal.sourceContext ?? {}),
    smsApproval: { code, recipientUserId, sentAt: new Date().toISOString() },
  };
  const updated = await deps.proposalRepo.update(proposal.tenantId, proposal.id, {
    sourceContext: stampedContext,
  });
  const stamped = updated ?? { ...proposal, sourceContext: stampedContext };

  try {
    const result = await deps.messageDelivery.sendSms({
      to: recipientE164,
      tenantId: proposal.tenantId,
      body: renderApprovalRequestSms(stamped, code),
      idempotencyKey: `proposal-approval-request:${proposal.id}`,
    });

    if (deps.auditRepo) {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: proposal.tenantId,
          actorId: 'system',
          actorRole: 'owner',
          eventType: 'proposal_approval.sms_requested',
          entityType: 'proposal',
          entityId: proposal.id,
          metadata: {
            proposalType: proposal.proposalType,
            recipientUserId,
            providerMessageId: result.providerMessageId,
          },
        }),
      );
    }

    return { sent: true, code, providerMessageId: result.providerMessageId };
  } catch (err) {
    logger.error('proposal-approval: approval-request send failed', {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, reason: 'send_failed', code };
  }
}
