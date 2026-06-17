/**
 * U6 (CRM Jobber parity, Phase 2 — communication loop): owner-authored
 * outbound reply send path.
 *
 * The missing outbound half of two-way messaging. The owner reads a customer
 * thread in the unified inbox (U5) and types a free-text reply; this service
 * sends it over SMS or email, records it on the dispatch ledger, and threads
 * the outbound message back onto the conversation so the round-trip is one
 * continuous history.
 *
 * Trust model (Key Decision in the Phase-2 plan): an owner typing a reply and
 * pressing send IS the human approval gate, so this is a DIRECT mutation, not
 * a proposal. AI-initiated outreach (re-engagement) stays proposal-gated; this
 * does not. The hard guarantee we still enforce is DNC/STOP suppression: a
 * number that opted out is NEVER messaged, even by a human. We deliberately do
 * NOT require the customer's `sms_consent` flag here (unlike the estimate/
 * invoice send): replies are to a customer-initiated thread, and requiring a
 * stored consent bit would block legitimate human replies. DNC remains the
 * absolute block.
 *
 * Reuses the same delivery providers, DNC repository, and dispatch ledger every
 * other outbound send writes to (entity_type='conversation_reply'), so delivery
 * accounting and suppression stay uniform across transactional and
 * conversational sends.
 */
import { createAuditEvent, AuditRepository } from '../audit/audit';
import { DncRepository, normalizePhone } from '../compliance/dnc';
import {
  DispatchRepository,
  CreateDispatchInput,
} from '../notifications/dispatch-repository';
import { MessageDeliveryProvider } from '../notifications/delivery-provider';
import type { Customer } from '../customers/customer';
import { UNMATCHED_SMS_ENTITY_TYPE } from '../sms/inbound-capture';
import type {
  ConversationRepository,
  Message,
} from './conversation-service';

export type ReplyChannel = 'sms' | 'email';

export type ConversationReplyErrorCode =
  | 'not_found'
  | 'empty_body'
  | 'no_recipient'
  | 'dnc_blocked'
  | 'delivery_failed';

export class ConversationReplyError extends Error {
  constructor(
    public readonly code: ConversationReplyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationReplyError';
  }
}

export interface ConversationReplyDeps {
  conversationRepo: Pick<ConversationRepository, 'findById' | 'addMessage'>;
  customerRepo: { findById(tenantId: string, id: string): Promise<Customer | null> };
  dncRepo: Pick<DncRepository, 'isOnDnc'>;
  dispatchRepo: Pick<DispatchRepository, 'create'>;
  delivery: MessageDeliveryProvider;
  auditRepo?: Pick<AuditRepository, 'create'>;
  /** Business name for the email subject line. */
  businessName?: string;
  now?: () => Date;
}

export interface SendConversationReplyInput {
  tenantId: string;
  conversationId: string;
  body: string;
  actorId: string;
  actorRole: string;
  /** Override the auto-resolved channel (else customer.preferredChannel). */
  channel?: ReplyChannel;
}

export interface SendConversationReplyResult {
  message: Message;
  dispatchId: string;
  channel: ReplyChannel;
  recipient: string;
  provider: string;
  providerMessageId: string;
}

interface ResolvedTarget {
  channel: ReplyChannel;
  recipient: string;
}

/**
 * Resolve which channel + address an outbound reply goes to. Customer threads
 * honour `preferredChannel` (falling back to the other channel if the preferred
 * one has no address on file); phone-keyed unmatched threads always reply by
 * SMS to the originating number (the conversation's entityId is the E.164).
 */
async function resolveTarget(
  input: SendConversationReplyInput,
  entityType: string | undefined,
  entityId: string | undefined,
  deps: ConversationReplyDeps,
): Promise<ResolvedTarget> {
  if (entityType === UNMATCHED_SMS_ENTITY_TYPE && entityId) {
    return { channel: 'sms', recipient: entityId };
  }

  if (entityType === 'customer' && entityId) {
    const customer = await deps.customerRepo.findById(input.tenantId, entityId);
    if (!customer) {
      throw new ConversationReplyError(
        'no_recipient',
        'Conversation customer no longer exists',
      );
    }
    const preferred: ReplyChannel =
      input.channel ?? (customer.preferredChannel === 'email' ? 'email' : 'sms');
    const phone = customer.primaryPhone?.trim() || undefined;
    const email = customer.email?.trim() || undefined;

    // Use the preferred channel when it has an address; otherwise fall back to
    // the other channel rather than dead-ending the owner's reply.
    if (preferred === 'email' && email) return { channel: 'email', recipient: email };
    if (preferred === 'sms' && phone) return { channel: 'sms', recipient: phone };
    if (phone) return { channel: 'sms', recipient: phone };
    if (email) return { channel: 'email', recipient: email };
    throw new ConversationReplyError(
      'no_recipient',
      'Customer has no phone or email on file to reply to',
    );
  }

  throw new ConversationReplyError(
    'no_recipient',
    'Conversation is not linked to a repliable customer or phone',
  );
}

function buildIdempotencyKey(
  conversationId: string,
  channel: ReplyChannel,
  nowMs: number,
): string {
  // Quantise to a 1-minute window so a double-tap dedupes at the provider and
  // the dispatch ledger, while a deliberate re-send minutes later is new.
  const minute = Math.floor(nowMs / 60_000);
  return `conversation_reply:${conversationId}:${channel}:${minute}`;
}

export async function sendConversationReply(
  deps: ConversationReplyDeps,
  input: SendConversationReplyInput,
): Promise<SendConversationReplyResult> {
  const body = input.body.trim();
  if (!body) {
    throw new ConversationReplyError('empty_body', 'Reply body cannot be empty');
  }

  const conversation = await deps.conversationRepo.findById(
    input.tenantId,
    input.conversationId,
  );
  if (!conversation) {
    throw new ConversationReplyError('not_found', 'Conversation not found');
  }

  const target = await resolveTarget(
    input,
    conversation.entityType,
    conversation.entityId,
    deps,
  );

  // DNC/STOP is the absolute block — never message an opted-out number, even
  // for a human-authored reply. No dispatch row is written for a blocked send.
  if (target.channel === 'sms') {
    const onDnc = await deps.dncRepo.isOnDnc(
      input.tenantId,
      normalizePhone(target.recipient),
    );
    if (onDnc) {
      throw new ConversationReplyError(
        'dnc_blocked',
        'Recipient has opted out (STOP/DNC); reply not sent',
      );
    }
  }

  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const idempotencyKey = buildIdempotencyKey(input.conversationId, target.channel, nowMs);

  let provider: string;
  let providerMessageId: string;
  try {
    if (target.channel === 'sms') {
      const result = await deps.delivery.sendSms({
        to: target.recipient,
        body,
        tenantId: input.tenantId,
        idempotencyKey,
      });
      provider = result.provider;
      providerMessageId = result.providerMessageId;
    } else {
      const result = await deps.delivery.sendEmail({
        to: target.recipient,
        subject: `Message from ${deps.businessName ?? 'your service provider'}`,
        text: body,
        tenantId: input.tenantId,
        idempotencyKey,
      });
      provider = result.provider;
      providerMessageId = result.providerMessageId;
    }
  } catch (err) {
    // Provider failure — record a failed dispatch row for observability, then
    // surface the error. The idempotency key means a retry won't double-send.
    const failedDispatch: CreateDispatchInput = {
      tenantId: input.tenantId,
      entityType: 'conversation_reply',
      entityId: input.conversationId,
      channel: target.channel,
      recipient: target.recipient,
      provider: 'unknown',
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
      idempotencyKey,
    };
    try {
      await deps.dispatchRepo.create(failedDispatch);
    } catch {
      /* best-effort failure record */
    }
    throw new ConversationReplyError(
      'delivery_failed',
      err instanceof Error ? err.message : 'Reply delivery failed',
    );
  }

  const dispatch = await deps.dispatchRepo.create({
    tenantId: input.tenantId,
    entityType: 'conversation_reply',
    entityId: input.conversationId,
    channel: target.channel,
    recipient: target.recipient,
    provider,
    providerMessageId,
    status: 'sent',
    idempotencyKey,
  });

  const message = await deps.conversationRepo.addMessage({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageType: 'text',
    content: body,
    senderId: input.actorId,
    senderRole: input.actorRole,
    source: target.channel,
    metadata: {
      direction: 'outbound',
      channel: target.channel,
      recipient: target.recipient,
      dispatchId: dispatch.id,
    },
  });

  if (deps.auditRepo) {
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: input.tenantId,
          actorId: input.actorId,
          actorRole: input.actorRole,
          eventType: 'conversation.reply.sent',
          entityType: 'conversation',
          entityId: input.conversationId,
          correlationId: dispatch.id,
          metadata: {
            channel: target.channel,
            recipient: target.recipient,
            dispatchId: dispatch.id,
            messageId: message.id,
          },
        }),
      );
    } catch {
      /* audit is best-effort — never fail a sent reply on a ledger write */
    }
  }

  return {
    message,
    dispatchId: dispatch.id,
    channel: target.channel,
    recipient: target.recipient,
    provider,
    providerMessageId,
  };
}
