/**
 * #1738 — production `SpeedToLeadSender`: find-or-open the lead's
 * conversation, then send through `sendConversationReply`, the DNC-gated path:
 * an opted-out number is refused (`dnc_blocked`, audited) and the throw is
 * recorded by `sendSpeedToLeadResponse` as the outcome. The SMS-consent check
 * itself happens BEFORE this, in the caller (LSA: `sms_consent` asserted by
 * Google; web form / portal: the visitor's ticked box or the customer's stored
 * consent), because the reply path only checks consent for customers, not
 * leads.
 */
import type { AuditRepository } from '../audit/audit';
import { sendConversationReply, type ConversationReplyDeps } from '../conversations/reply-service';
import type { SpeedToLeadSender } from './speed-to-lead';
import { openOrAppendConversation } from '../sms/inbound-capture';

export interface LeadConversationSenderDeps {
  reply: Omit<ConversationReplyDeps, 'businessName'>;
  conversationRepo: Parameters<typeof openOrAppendConversation>[2]['conversationRepo'];
  auditRepo: AuditRepository;
  getBusinessName(tenantId: string): Promise<string | undefined>;
}

export interface LeadConversationSenderOptions {
  /** Title of the lead conversation the text opens (or appends to). */
  title: string;
  /** System actor recorded on the conversation and the reply audit. */
  actorId: string;
}

export function createLeadConversationSender(
  deps: LeadConversationSenderDeps,
  opts: LeadConversationSenderOptions,
): SpeedToLeadSender {
  return async ({ tenantId, leadId, body }) => {
    const conversation = await openOrAppendConversation(
      { tenantId },
      { entityType: 'lead', entityId: leadId, title: opts.title, leadId },
      { conversationRepo: deps.conversationRepo },
      { createdBy: opts.actorId, auditRepo: deps.auditRepo, actorRole: 'system' },
    );
    const businessName = await deps.getBusinessName(tenantId);
    await sendConversationReply(
      { ...deps.reply, auditRepo: deps.auditRepo, ...(businessName ? { businessName } : {}) },
      {
        tenantId,
        conversationId: conversation.id,
        body,
        actorId: opts.actorId,
        actorRole: 'system',
        channel: 'sms',
      },
    );
  };
}
