/**
 * #1738 — production `SpeedToLeadSender` for LSA leads: find-or-open the lead's
 * conversation, then send through `sendConversationReply`, the DNC-gated path:
 * an opted-out number is refused (`dnc_blocked`, audited) and the throw is
 * recorded by `sendSpeedToLeadResponse` as the outcome. The SMS-consent check
 * itself happens BEFORE this in the webhook handler (`sms_consent` must be
 * asserted by the sender), because the reply path only checks consent for
 * customers, not leads.
 */
import type { AuditRepository } from '../audit/audit';
import { sendConversationReply, type ConversationReplyDeps } from '../conversations/reply-service';
import type { SpeedToLeadSender } from '../leads/speed-to-lead';
import { openOrAppendConversation } from '../sms/inbound-capture';

export interface LsaSpeedToLeadSenderDeps {
  reply: Omit<ConversationReplyDeps, 'businessName'>;
  conversationRepo: Parameters<typeof openOrAppendConversation>[2]['conversationRepo'];
  auditRepo: AuditRepository;
  getBusinessName(tenantId: string): Promise<string | undefined>;
}

export function createLsaSpeedToLeadSender(deps: LsaSpeedToLeadSenderDeps): SpeedToLeadSender {
  return async ({ tenantId, leadId, body }) => {
    const conversation = await openOrAppendConversation(
      { tenantId },
      { entityType: 'lead', entityId: leadId, title: 'Google Local Services lead', leadId },
      { conversationRepo: deps.conversationRepo },
      { createdBy: 'system:lsa', auditRepo: deps.auditRepo, actorRole: 'system' },
    );
    const businessName = await deps.getBusinessName(tenantId);
    await sendConversationReply(
      { ...deps.reply, auditRepo: deps.auditRepo, ...(businessName ? { businessName } : {}) },
      {
        tenantId,
        conversationId: conversation.id,
        body,
        actorId: 'system:lsa',
        actorRole: 'system',
        channel: 'sms',
      },
    );
  };
}
