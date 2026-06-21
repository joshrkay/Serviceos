/**
 * LC-3 — speed-to-lead auto-response worker.
 *
 * On a new inbound lead (enqueued from createLead), send an immediate
 * customer-facing reply so the prospect hears back within seconds. Copy is
 * AI-templated through the LLM gateway (never a direct provider call) with a
 * deterministic fallback so the SLA send still happens if the model is down.
 * Delivery routes through the consent/DNC-gated customer-message-delivery
 * service: SMS fires only when the lead gave explicit consent AND the number
 * isn't on the DNC list; email is unconditional. The reply is logged to the
 * lead's conversation thread and audited.
 *
 * Idempotent: re-running (queue retry) is a no-op once an auto-response message
 * exists on the thread, and the delivery layer dedups by idempotency key. The
 * PgQueue poll loop retries on thrown errors and DLQs after max attempts.
 */
import { Logger } from '../logging/logger';
import { QueueMessage, WorkerHandler } from '../queues/queue';
import { Lead, LeadRepository } from '../leads/lead';
import { SettingsRepository } from '../settings/settings';
import { LLMGateway } from '../ai/gateway/gateway';
import { MessageDeliveryProvider } from '../notifications/delivery-provider';
import { DispatchRepository } from '../notifications/dispatch-repository';
import { DncRepository } from '../compliance/dnc';
import { sendCustomerMessage } from '../notifications/customer-message-delivery';
import { ConversationRepository } from '../conversations/conversation-service';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { Customer } from '../customers/customer';

export const LEAD_AUTO_RESPONSE_JOB_TYPE = 'lead_auto_response';

export interface LeadAutoResponsePayload {
  tenantId: string;
  leadId: string;
}

const ACTOR_ID = 'lead_auto_response_worker';
const ACTOR_ROLE = 'system';
const MESSAGE_SOURCE = 'lead_auto_response';

export interface LeadAutoResponseDeps {
  leadRepo: LeadRepository;
  settingsRepo: SettingsRepository;
  conversationRepo: ConversationRepository;
  dispatchRepo: DispatchRepository;
  dncRepo: DncRepository;
  auditRepo: AuditRepository;
  /** Optional — when absent, copy uses the deterministic fallback template. */
  gateway?: LLMGateway;
  /** Optional — when absent (no provider configured), nothing is sent. */
  delivery?: MessageDeliveryProvider | null;
}

function leadFirstName(lead: Lead): string {
  return lead.firstName?.trim() || 'there';
}

/** Deterministic fallback copy — used when no gateway is wired or it fails. */
function fallbackCopy(lead: Lead, businessName: string): string {
  return (
    `Hi ${leadFirstName(lead)}, thanks for reaching out to ${businessName}! ` +
    `We've got your request and will be in touch very shortly. Reply STOP to opt out.`
  );
}

async function renderCopy(
  deps: LeadAutoResponseDeps,
  lead: Lead,
  businessName: string,
  logger: Logger,
): Promise<string> {
  const fallback = fallbackCopy(lead, businessName);
  if (!deps.gateway) return fallback;
  try {
    const res = await deps.gateway.complete({
      taskType: LEAD_AUTO_RESPONSE_JOB_TYPE,
      tenantId: lead.tenantId,
      maxTokens: 200,
      messages: [
        {
          role: 'system',
          content:
            'You write a single warm, concise SMS auto-reply (max 320 characters) ' +
            'to a new inbound lead for a home-services business. Acknowledge their ' +
            'request, say someone will follow up shortly. No markdown, no links, no ' +
            'emojis. End with "Reply STOP to opt out."',
        },
        {
          role: 'user',
          content:
            `Business: ${businessName}\n` +
            `Lead first name: ${leadFirstName(lead)}\n` +
            `What they sent: ${lead.sourceDetail ?? 'a service request'}\n` +
            'Write the reply text only.',
        },
      ],
    });
    const text = res.content?.trim();
    return text && text.length > 0 ? text : fallback;
  } catch (err) {
    logger.warn('Lead auto-response copy generation failed; using fallback', {
      tenantId: lead.tenantId,
      leadId: lead.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

/** Minimal Customer-shaped object so the lead can reuse the consent/DNC-gated
 *  delivery service without a real customer row. */
function syntheticCustomerFromLead(lead: Lead): Customer {
  const now = new Date();
  return {
    id: lead.id,
    tenantId: lead.tenantId,
    firstName: lead.firstName ?? '',
    lastName: lead.lastName ?? '',
    displayName: [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'Lead',
    companyName: lead.companyName,
    primaryPhone: lead.primaryPhone,
    secondaryPhone: undefined,
    email: lead.email,
    preferredChannel: lead.primaryPhone ? 'sms' : lead.email ? 'email' : 'none',
    smsConsent: lead.smsConsent === true,
    communicationNotes: undefined,
    isArchived: false,
    archivedAt: undefined,
    originatingLeadId: lead.id,
    preferredLanguage: lead.preferredLanguage,
    createdBy: ACTOR_ID,
    createdAt: now,
    updatedAt: now,
  };
}

export function createLeadAutoResponseWorker(
  deps: LeadAutoResponseDeps,
): WorkerHandler<LeadAutoResponsePayload> {
  return {
    type: LEAD_AUTO_RESPONSE_JOB_TYPE,

    async handle(message: QueueMessage<LeadAutoResponsePayload>, logger: Logger): Promise<void> {
      const { tenantId, leadId } = message.payload;

      const lead = await deps.leadRepo.findById(tenantId, leadId);
      if (!lead) {
        logger.warn('Lead auto-response skipped: lead not found', { tenantId, leadId });
        return;
      }
      if (!lead.primaryPhone && !lead.email) {
        logger.info('Lead auto-response skipped: no contact channel', { tenantId, leadId });
        return;
      }

      // Idempotency: get-or-create the lead's conversation thread, then bail if
      // an auto-response already landed (queue retry / duplicate enqueue).
      const threads = await deps.conversationRepo.findByEntity(tenantId, 'lead', leadId);
      let conversationId = (threads.find((t) => t.status !== 'archived') ?? threads[0])?.id;
      if (conversationId) {
        const existing = await deps.conversationRepo.getMessages(tenantId, conversationId);
        if (existing.some((m) => m.source === MESSAGE_SOURCE)) {
          logger.info('Lead auto-response already sent; skipping', { tenantId, leadId });
          return;
        }
      } else {
        const conv = await deps.conversationRepo.createConversation({
          tenantId,
          entityType: 'lead',
          entityId: leadId,
          createdBy: ACTOR_ID,
          title: lead.firstName || lead.companyName || lead.primaryPhone || 'New lead',
        });
        conversationId = conv.id;
      }

      const settings = await deps.settingsRepo.findByTenant(tenantId);
      const businessName = settings?.businessName ?? 'our team';
      const copy = await renderCopy(deps, lead, businessName, logger);

      // Consent/DNC-gated delivery (best-effort; SMS only with explicit
      // consent, email unconditional). Idempotent by key across retries.
      if (deps.delivery) {
        await sendCustomerMessage(
          {
            delivery: deps.delivery,
            dispatchRepo: deps.dispatchRepo,
            dncRepo: deps.dncRepo,
          },
          {
            tenantId,
            customer: syntheticCustomerFromLead(lead),
            entityType: 'lead_auto_response',
            entityId: lead.id,
            channels: ['sms', 'email'],
            smsBody: copy,
            emailSubject: `Thanks for contacting ${businessName}`,
            emailText: copy,
            idempotencyKeyPrefix: `${LEAD_AUTO_RESPONSE_JOB_TYPE}:${lead.id}`,
          },
        );
      } else {
        logger.info('Lead auto-response: no delivery provider configured; logging only', {
          tenantId,
          leadId,
        });
      }

      // Log the outbound reply to the lead's thread (the inbox record).
      await deps.conversationRepo.addMessage({
        tenantId,
        conversationId,
        messageType: 'text',
        content: copy,
        senderId: ACTOR_ID,
        senderRole: 'system',
        source: MESSAGE_SOURCE,
        metadata: {
          direction: 'outbound',
          automated: true,
          smsConsent: lead.smsConsent === true,
        },
      });

      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: ACTOR_ID,
          actorRole: ACTOR_ROLE,
          eventType: 'lead.auto_responded',
          entityType: 'lead',
          entityId: lead.id,
          metadata: {
            source: lead.source,
            smsConsent: lead.smsConsent === true,
            hasEmail: Boolean(lead.email),
          },
        }),
      );

      logger.info('Lead auto-response processed', { tenantId, leadId });
    },
  };
}
