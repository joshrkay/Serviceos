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
import { createHash } from 'crypto';
import { createAuditEvent, AuditRepository } from '../audit/audit';
import { DncRepository, normalizePhone } from '../compliance/dnc';
import {
  DispatchRepository,
  CreateDispatchInput,
} from '../notifications/dispatch-repository';
import { MessageDeliveryProvider } from '../notifications/delivery-provider';
import type { Customer } from '../customers/customer';
import type { Lead } from '../leads/lead';
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
  | 'channel_selection_required'
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
  conversationRepo: Pick<
    ConversationRepository,
    'findById' | 'addMessage' | 'getMessages' | 'findLatestInboundChannel'
  >;
  customerRepo: { findById(tenantId: string, id: string): Promise<Customer | null> };
  /** Lead lookup — required to reply to a lead-linked thread (unknown-caller
   *  captures). Optional: without it, lead threads resolve to no_recipient. */
  leadRepo?: { findById(tenantId: string, id: string): Promise<Lead | null> };
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
  /**
   * Explicit channel selection. Comms C3 (spec §3/§4): a reply resolves
   * within its own channel thread — the default is the channel the customer
   * last used in this conversation, and switching to the OTHER channel
   * (cross-channel reply) requires this to be set explicitly. When the
   * default is unresolvable and both channels are deliverable, the send
   * fails with `channel_selection_required` rather than guessing.
   */
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
 * Comms C3 channel-selection discipline, shared by customer and lead
 * threads. `defaultChannel` is what the thread/preference resolution
 * produced; a cross-channel switch away from it is never silent.
 */
function pickReplyChannel(opts: {
  explicit?: ReplyChannel;
  defaultChannel?: ReplyChannel;
  /**
   * Where `defaultChannel` came from. 'thread' = the channel the customer
   * last used in THIS conversation — switching away from it is a
   * cross-channel reply and must be explicit. 'fallback' = a stored
   * preference or capture-channel default — merely a tie-breaker, so when
   * its address is missing the send may still fall through to the only
   * deliverable channel (deterministic, not a guess).
   */
  defaultSource?: 'thread' | 'fallback';
  phone?: string;
  email?: string;
  who: 'Customer' | 'Lead';
}): ResolvedTarget {
  const addressFor = (channel: ReplyChannel): string | undefined =>
    channel === 'sms' ? opts.phone : opts.email;

  if (opts.explicit) {
    const recipient = addressFor(opts.explicit);
    if (recipient) return { channel: opts.explicit, recipient };
    throw new ConversationReplyError(
      'no_recipient',
      `${opts.who} has no ${opts.explicit === 'sms' ? 'phone' : 'email'} on file for the selected channel`,
    );
  }

  const deliverable: ReplyChannel[] = [];
  if (opts.phone) deliverable.push('sms');
  if (opts.email) deliverable.push('email');

  if (deliverable.length === 0) {
    throw new ConversationReplyError(
      'no_recipient',
      `${opts.who} has no phone or email on file to reply to`,
    );
  }

  if (opts.defaultChannel) {
    const recipient = addressFor(opts.defaultChannel);
    if (recipient) return { channel: opts.defaultChannel, recipient };
    // The thread's own channel has no address on file — sending on the
    // other channel is a cross-channel reply and requires explicit
    // selection. Only thread-derived defaults get this hard stop; a
    // preference/capture default with no address falls through to the
    // single-deliverable resolution below.
    if (opts.defaultSource === 'thread') {
      throw new ConversationReplyError(
        'channel_selection_required',
        `The ${opts.defaultChannel === 'sms' ? 'text' : 'email'} channel this thread uses has no address on file — pick a channel explicitly to reply another way`,
      );
    }
  }

  // One deliverable channel is deterministic, not a guess; two with no
  // usable default is ambiguous and must ask.
  if (deliverable.length === 1) {
    const channel = deliverable[0];
    return { channel, recipient: addressFor(channel)! };
  }
  throw new ConversationReplyError(
    'channel_selection_required',
    `${opts.who} is reachable by both text and email and this thread has no prior channel — pick a channel explicitly`,
  );
}

/**
 * Comms C3 — the channel the customer last used in this conversation.
 * Inbound messages are stamped `metadata.direction='inbound'` at capture
 * (sms/inbound-capture.ts); the channel is `metadata.channel` falling back
 * to `source`. Returns undefined for owner-initiated threads with no
 * inbound traffic yet.
 */
async function lastInboundChannel(
  deps: ConversationReplyDeps,
  tenantId: string,
  conversationId: string,
): Promise<ReplyChannel | undefined> {
  // Bounded repo lookup when available (Pg: ORDER BY … DESC LIMIT 1) — a
  // long-running thread must not be fully scanned on every send. The
  // getMessages scan below is the fallback for harnesses that stub only
  // the minimal repo surface.
  if (deps.conversationRepo.findLatestInboundChannel) {
    return (
      (await deps.conversationRepo.findLatestInboundChannel(tenantId, conversationId)) ??
      undefined
    );
  }
  const messages = await deps.conversationRepo.getMessages(tenantId, conversationId);
  let latest: { at: number; channel: ReplyChannel } | undefined;
  for (const m of messages) {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    if (meta.direction !== 'inbound') continue;
    const channel = (meta.channel as string | undefined) ?? m.source;
    if (channel !== 'sms' && channel !== 'email') continue;
    const at = m.createdAt instanceof Date ? m.createdAt.getTime() : 0;
    if (!latest || at >= latest.at) latest = { at, channel };
  }
  return latest?.channel;
}

/**
 * Resolve which channel + address an outbound reply goes to.
 *
 * Comms C3 (spec §3/§4) — a reply resolves within its own channel thread:
 *   explicit operator selection → the channel the customer last used in this
 *   conversation → the customer's preferred channel → the only deliverable
 *   channel. A cross-channel flip is never silent: when the resolved default
 *   channel has no address on file (or nothing resolves a default) and BOTH
 *   channels are deliverable, the send fails with
 *   `channel_selection_required` instead of guessing.
 *
 * Phone-keyed unmatched threads always reply by SMS to the originating
 * number (the conversation's entityId is the E.164).
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

  if (entityType === 'lead' && entityId) {
    if (!deps.leadRepo) {
      throw new ConversationReplyError(
        'no_recipient',
        'Lead replies are not configured',
      );
    }
    const lead = await deps.leadRepo.findById(input.tenantId, entityId);
    if (!lead) {
      throw new ConversationReplyError('no_recipient', 'Conversation lead no longer exists');
    }
    const phone = lead.primaryPhone?.trim() || undefined;
    const email = lead.email?.trim() || undefined;
    // Leads carry no channel preference; the thread channel (last inbound)
    // governs, defaulting to SMS — the capture channel.
    const threadChannel = await lastInboundChannel(
      deps,
      input.tenantId,
      input.conversationId,
    );
    return pickReplyChannel({
      explicit: input.channel,
      defaultChannel: threadChannel ?? 'sms',
      defaultSource: threadChannel ? 'thread' : 'fallback',
      phone,
      email,
      who: 'Lead',
    });
  }

  if (entityType === 'customer' && entityId) {
    const customer = await deps.customerRepo.findById(input.tenantId, entityId);
    if (!customer) {
      throw new ConversationReplyError(
        'no_recipient',
        'Conversation customer no longer exists',
      );
    }
    const phone = customer.primaryPhone?.trim() || undefined;
    const email = customer.email?.trim() || undefined;

    // The thread's own channel (last inbound) governs; the stored channel
    // preference only breaks the tie for owner-initiated threads with no
    // inbound traffic yet. 'phone' preference maps to SMS for a typed reply;
    // 'none' resolves nothing and asks when both channels are deliverable.
    const threadChannel = await lastInboundChannel(
      deps,
      input.tenantId,
      input.conversationId,
    );
    const preferenceChannel: ReplyChannel | undefined =
      customer.preferredChannel === 'email'
        ? 'email'
        : customer.preferredChannel === 'sms' || customer.preferredChannel === 'phone'
          ? 'sms'
          : undefined;
    return pickReplyChannel({
      explicit: input.channel,
      defaultChannel: threadChannel ?? preferenceChannel,
      defaultSource: threadChannel ? 'thread' : 'fallback',
      phone,
      email,
      who: 'Customer',
    });
  }

  throw new ConversationReplyError(
    'no_recipient',
    'Conversation is not linked to a repliable customer or phone',
  );
}

function buildIdempotencyKey(
  conversationId: string,
  channel: ReplyChannel,
  body: string,
  nowMs: number,
): string {
  // Quantise to a 1-minute window so a true double-tap (same reply text fired
  // twice) dedupes at the provider and the dispatch ledger, while a deliberate
  // re-send minutes later is new. The body hash disambiguates DIFFERENT replies
  // sent in the same minute: without it, two distinct messages collided on one
  // key and the second hit the message_dispatches unique (tenant_id,
  // idempotency_key) constraint — dropped or mis-threaded. A short sha256 of
  // the trimmed body keeps identical re-taps colliding (intended dedupe) while
  // separating non-identical sends.
  const minute = Math.floor(nowMs / 60_000);
  const bodyHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  return `conversation_reply:${conversationId}:${channel}:${minute}:${bodyHash}`;
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
  const idempotencyKey = buildIdempotencyKey(
    input.conversationId,
    target.channel,
    body,
    nowMs,
  );

  let provider: string;
  let providerMessageId: string;
  try {
    if (target.channel === 'sms') {
      const result = await deps.delivery.sendSms({
        to: target.recipient,
        body,
        tenantId: input.tenantId,
        idempotencyKey,
        // Customer-facing, but this is a human-authored reply to a customer-
        // initiated thread: the owner pressing Send IS the consent, so we mark
        // consent granted (see the trust-model note in the file header). DNC is
        // still the absolute block — enforced above AND re-checked by the gate.
        recipientClass: 'customer',
        consent: { smsConsent: true },
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
