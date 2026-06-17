/**
 * U4 (CRM Jobber parity, Phase 2 — communication loop): capture-all inbound
 * SMS → customer thread.
 *
 * The inbound-SMS dispatcher consults a chain of handlers (keyword → owner-edit
 * fallback → dropped-call recovery → negotiation guardrail). Anything none of
 * them claims used to fall on the floor — a customer texting "is the tech still
 * coming?" got no thread, no inbox entry, nothing. This handler is registered
 * as the ABSOLUTE last resort (after the negotiation guardrail): it resolves the
 * sender's phone to a customer, opens-or-appends that customer's conversation,
 * and threads the text on so it surfaces in the unified inbox (U5) and on the
 * customer timeline.
 *
 * Trust-model notes:
 *   • STOP/START are keyword handlers that short-circuit far upstream
 *     (compliance/stop-reply.ts), so an opt-out message never reaches capture.
 *   • Capture is read-mostly: it only writes a `messages` row (and opens a
 *     conversation when none exists). It never sends anything, so there is no
 *     DNC/consent surface here — that gate lives on the OUTBOUND reply (U6).
 *   • Unknown / ambiguous numbers are NOT silently dropped and are NOT
 *     auto-converted into leads (which would let spam/wrong-number texts spam
 *     the leads list). They thread under a lightweight phone-keyed
 *     conversation (`entityType: 'sms_unmatched'`, `entityId` = digits-only
 *     phone) so repeat texts from the same unknown number group together and
 *     the owner can still read + reply to them from the inbox.
 */
import { createAuditEvent, AuditRepository } from '../audit/audit';
import type { Customer } from '../customers/customer';
import { normalizePhone } from '../customers/dedup';
import type {
  Conversation,
  ConversationRepository,
} from '../conversations/conversation-service';
import type { FallbackHandler, InboundSmsContext, HandlerResult } from './inbound-dispatch';
import type { Logger } from '../logging/logger';

/** Conversation entity type used for inbound texts we could not pin to a
 *  single customer. Keyed by the digits-only sender phone so the same unknown
 *  number always reuses one thread. */
export const UNMATCHED_SMS_ENTITY_TYPE = 'sms_unmatched';

export interface InboundCaptureDeps {
  conversationRepo: Pick<
    ConversationRepository,
    'createConversation' | 'findByEntity' | 'addMessage'
  >;
  /** Phone→customer resolver. Optional method on the repo; when absent (or it
   *  returns ≠1 match) the text threads as unmatched rather than guessing. */
  customerRepo: {
    findByPhoneNormalized?(
      tenantId: string,
      phoneNormalized: string,
    ): Promise<Customer[]>;
  };
  auditRepo?: Pick<AuditRepository, 'create'>;
  logger?: Logger;
}

interface ThreadTarget {
  entityType: string;
  entityId: string;
  title: string;
  customerId?: string;
}

/**
 * Resolve which conversation a text belongs to. Exactly one customer match →
 * that customer's thread; zero or many → a phone-keyed unmatched thread (never
 * a silent guess between multiple customers).
 */
async function resolveThreadTarget(
  ctx: InboundSmsContext,
  phoneNormalized: string,
  deps: InboundCaptureDeps,
): Promise<ThreadTarget> {
  const unmatched: ThreadTarget = {
    entityType: UNMATCHED_SMS_ENTITY_TYPE,
    // Key by the full E.164 (not digits-only) so the owner can reply straight
    // to the originating number from the inbox (U6 reads entityId as the
    // recipient). Twilio sends a stable E.164, so repeat texts still group.
    entityId: ctx.fromE164,
    title: `SMS from ${ctx.fromE164}`,
  };
  if (!deps.customerRepo.findByPhoneNormalized || !phoneNormalized) {
    return unmatched;
  }
  const matches = await deps.customerRepo.findByPhoneNormalized(
    ctx.tenantId,
    phoneNormalized,
  );
  if (matches.length !== 1) {
    return unmatched;
  }
  const customer = matches[0];
  return {
    entityType: 'customer',
    entityId: customer.id,
    title: customer.displayName || `SMS from ${ctx.fromE164}`,
    customerId: customer.id,
  };
}

/** Most-recent OPEN conversation for the target, or open a fresh one. */
async function openOrAppendConversation(
  ctx: InboundSmsContext,
  target: ThreadTarget,
  deps: InboundCaptureDeps,
): Promise<Conversation> {
  const existing = await deps.conversationRepo.findByEntity(
    ctx.tenantId,
    target.entityType,
    target.entityId,
  );
  // findByEntity returns newest-first; reuse the latest still-open thread so a
  // back-and-forth lands on one conversation instead of spawning one per text.
  const openThread = existing.find((c) => c.status === 'open');
  if (openThread) return openThread;
  return deps.conversationRepo.createConversation({
    tenantId: ctx.tenantId,
    title: target.title,
    entityType: target.entityType,
    entityId: target.entityId,
    createdBy: 'system:sms-capture',
  });
}

export function createInboundCaptureHandler(
  deps: InboundCaptureDeps,
): FallbackHandler {
  return {
    name: 'sms-capture',
    async handle(ctx: InboundSmsContext): Promise<HandlerResult> {
      const body = ctx.body.trim();
      // The dispatcher already returns before the fallback chain on an empty
      // first token, so body is normally non-empty here; guard anyway so a
      // media-only/whitespace text is declined (the media handler owns those).
      if (!body) {
        return { handled: false, handler: 'sms-capture', reason: 'empty_body' };
      }

      try {
        const phoneNormalized = normalizePhone(ctx.fromE164);
        const target = await resolveThreadTarget(ctx, phoneNormalized, deps);
        const conversation = await openOrAppendConversation(ctx, target, deps);

        await deps.conversationRepo.addMessage({
          tenantId: ctx.tenantId,
          conversationId: conversation.id,
          messageType: 'text',
          content: ctx.body,
          senderId: ctx.fromE164,
          senderRole: 'customer',
          source: 'sms',
          metadata: {
            direction: 'inbound',
            channel: 'sms',
            messageSid: ctx.messageSid,
            fromE164: ctx.fromE164,
            ...(target.customerId ? {} : { unmatched: true }),
          },
        });

        if (deps.auditRepo) {
          try {
            await deps.auditRepo.create(
              createAuditEvent({
                tenantId: ctx.tenantId,
                actorId: 'system:sms-capture',
                actorRole: 'system',
                eventType: 'sms.inbound.captured',
                entityType: 'conversation',
                entityId: conversation.id,
                metadata: {
                  messageSid: ctx.messageSid,
                  fromE164: ctx.fromE164,
                  matched: Boolean(target.customerId),
                  ...(target.customerId ? { customerId: target.customerId } : {}),
                },
              }),
            );
          } catch {
            /* audit is best-effort — never fail capture on a ledger write */
          }
        }

        return { handled: true, handler: 'sms-capture' };
      } catch (err) {
        // Don't claim a message we failed to persist — decline so the webhook
        // records `sms.inbound.unhandled` rather than a false "captured".
        deps.logger?.error('Inbound SMS capture failed to persist', {
          tenantId: ctx.tenantId,
          messageSid: ctx.messageSid,
          error: err instanceof Error ? err.message : String(err),
        });
        return { handled: false, handler: 'sms-capture', reason: 'capture_error' };
      }
    },
  };
}
