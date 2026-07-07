/**
 * P8-015 / P0-037 — production RecoveryThreader.
 *
 * Threads the sent recovery SMS into the unified inbox and persists the
 * conversation links:
 *
 *   1. Resolve the thread target with the SAME phone→thread resolution as
 *      inbound capture (single customer match → customer thread; else lead;
 *      else sms_unmatched keyed by E.164). Identical resolution on both
 *      directions is what guarantees the caller's reply lands in the same
 *      thread as the recovery SMS.
 *   2. Open-or-append the conversation (shared 23505 one-open-thread race
 *      recovery), creating through createConversationWithAudit.
 *   3. Record the outbound message row so the recovery is visible in the
 *      inbox and on the customer timeline.
 *   4. Link the originating voice_session and the sms_conversation (the
 *      Twilio message sid) to the conversation via P0-037 links.
 *   5. Emit one dropped_call_recovery.threaded audit event covering the
 *      message + link writes.
 *
 * The handler treats thread as best-effort — a failure here is logged by
 * the caller and never causes a re-send.
 */
import { createAuditEvent, type AuditRepository } from '../../audit/audit';
import { normalizePhone } from '../../customers/dedup';
import {
  linkConversation,
  type ConversationLinkRepository,
} from '../../conversations/linkage';
import {
  openOrAppendConversation,
  resolveThreadTarget,
  type InboundCaptureDeps,
  type ThreadTargetDeps,
} from '../inbound-capture';
import type { Logger } from '../../logging/logger';
import type { RecoveryThreader } from './dropped-call-handler';
import { DEFAULT_SYSTEM_ACTOR } from './dropped-call-handler';

export interface RecoveryThreaderDeps {
  conversationRepo: InboundCaptureDeps['conversationRepo'];
  conversationLinkRepo: ConversationLinkRepository;
  customerRepo: ThreadTargetDeps['customerRepo'];
  leadRepo?: ThreadTargetDeps['leadRepo'];
  auditRepo: AuditRepository;
  logger: Logger;
}

export function createRecoveryThreader(deps: RecoveryThreaderDeps): RecoveryThreader {
  return async ({ tenantId, voiceSessionId, smsMessageSid, callerE164, body }) => {
    const resolutionDeps: ThreadTargetDeps = {
      customerRepo: deps.customerRepo,
      auditRepo: deps.auditRepo,
      logger: deps.logger,
      ...(deps.leadRepo ? { leadRepo: deps.leadRepo } : {}),
    };
    const target = await resolveThreadTarget(
      { tenantId, fromE164: callerE164 },
      normalizePhone(callerE164),
      resolutionDeps,
    );

    const conversation = await openOrAppendConversation(
      { tenantId },
      target,
      { conversationRepo: deps.conversationRepo },
      {
        createdBy: DEFAULT_SYSTEM_ACTOR,
        auditRepo: deps.auditRepo,
        actorRole: 'system',
      },
    );

    // The outbound message and the two P0-037 links are independent (each only
    // needs conversation.id, already in hand) — write them concurrently. Links
    // are idempotent on the four-column unique key, so a retried threading pass
    // re-links without duplicating.
    await Promise.all([
      deps.conversationRepo.addMessage({
        tenantId,
        conversationId: conversation.id,
        messageType: 'text',
        content: body,
        senderId: DEFAULT_SYSTEM_ACTOR,
        senderRole: 'system',
        source: 'sms',
        metadata: {
          direction: 'outbound',
          channel: 'sms',
          messageSid: smsMessageSid,
          voiceSessionId,
          toE164: callerE164,
          ...(target.customerId ? { customerId: target.customerId } : {}),
          ...(target.leadId ? { leadId: target.leadId } : {}),
        },
      }),
      linkConversation(
        {
          tenantId,
          conversationId: conversation.id,
          entityType: 'voice_session',
          entityId: voiceSessionId,
        },
        deps.conversationLinkRepo,
      ),
      linkConversation(
        {
          tenantId,
          conversationId: conversation.id,
          entityType: 'sms_conversation',
          entityId: smsMessageSid,
        },
        deps.conversationLinkRepo,
      ),
    ]);

    // Audit last, as the completion marker — only written once the three
    // writes above have landed.
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: DEFAULT_SYSTEM_ACTOR,
        actorRole: 'system',
        eventType: 'dropped_call_recovery.threaded',
        entityType: 'conversation',
        entityId: conversation.id,
        metadata: {
          voiceSessionId,
          smsMessageSid,
          threadEntityType: target.entityType,
          threadEntityId: target.entityId,
        },
      }),
    );
  };
}
