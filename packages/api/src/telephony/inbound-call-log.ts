import { maskPhone } from './twilio-call-control';
import type { AuditRepository } from '../audit/audit';
import {
  type Conversation,
  type ConversationRepository,
  getOrCreateCustomerConversation,
  type Message,
} from '../conversations/conversation-service';

export interface LogInboundCallInput {
  conversationRepo: ConversationRepository;
  tenantId: string;
  customerId: string;
  /** Raw caller phone (Twilio `From`). */
  fromPhone: string;
  callSid?: string;
  /** Disposition at the moment of logging (received / completed / voicemail …). */
  status?: string;
  /** Recorded as the message sender + conversation creator. */
  actorId?: string;
  auditRepo?: AuditRepository;
}

export interface LogInboundCallResult {
  conversation: Conversation;
  message: Message;
}

/**
 * Log an inbound call on the customer's conversation timeline — the inbound
 * mirror of outbound-call-service's logging. Gets/creates the customer's open
 * thread and appends a `system_event` message tagged `channel: 'call'`,
 * `direction: 'inbound'`, so an inbound call surfaces on the customer's
 * timeline / unified inbox exactly like an outbound one. Best-effort: callers
 * should not let a logging failure break call handling.
 */
export async function logInboundCallOnCustomerTimeline(
  input: LogInboundCallInput,
): Promise<LogInboundCallResult> {
  const {
    conversationRepo,
    tenantId,
    customerId,
    fromPhone,
    callSid,
    status = 'received',
    actorId = 'system:inbound-call',
    auditRepo,
  } = input;

  const { conversation } = await getOrCreateCustomerConversation(
    conversationRepo,
    { tenantId, customerId, createdBy: actorId, actorRole: 'system' },
    auditRepo,
  );

  const message = await conversationRepo.addMessage({
    tenantId,
    conversationId: conversation.id,
    messageType: 'system_event',
    content: `Inbound call from ${maskPhone(fromPhone)}`,
    senderId: actorId,
    senderRole: 'system',
    source: 'inbound_call',
    metadata: {
      direction: 'inbound',
      channel: 'call',
      status,
      from: fromPhone,
      ...(callSid ? { callSid } : {}),
    },
  });

  return { conversation, message };
}
