/**
 * P8-015 — Production wiring for dropped-call recovery handler deps.
 */
import type { Pool } from 'pg';
import type { Logger } from '../../logging/logger';
import type { AuditRepository } from '../../audit/audit';
import type { SettingsRepository } from '../../settings/settings';
import type { VoiceSessionRepository } from '../../voice/voice-session';
import type { MessageDeliveryProvider } from '../../notifications/delivery-provider';
import type { LLMGateway } from '../../ai/gateway/gateway';
import { composeBrandVoiceMessage } from '../../ai/brand-voice/composer';
import { PhoneRateLimiter } from '../../shared/rate-limit/phone-rate-limit';
import { linkConversation } from '../../conversations/linkage';
import type { ConversationLinkRepository } from '../../conversations/linkage';
import {
  RECOVERY_RATE_LIMIT_SCOPE,
  RECOVERY_RATE_LIMIT_MAX,
  RECOVERY_RATE_LIMIT_WINDOW_MS,
  type DroppedCallHandlerDeps,
} from './dropped-call-handler';

export interface CreateDroppedCallHandlerDepsInput {
  pool: Pool;
  auditRepo: AuditRepository;
  settingsRepo: SettingsRepository;
  voiceSessionRepo: VoiceSessionRepository;
  delivery: MessageDeliveryProvider;
  gateway: LLMGateway;
  conversationLinkRepo?: ConversationLinkRepository;
  logger: Logger;
  systemActorId?: string;
}

export function createDroppedCallHandlerDeps(
  input: CreateDroppedCallHandlerDepsInput,
): Omit<DroppedCallHandlerDeps, 'repo'> {
  const rateLimiter = new PhoneRateLimiter(input.pool);

  return {
    audit: input.auditRepo,
    logger: input.logger,
    systemActorId: input.systemActorId ?? 'system:dropped-call-recovery',
    rateLimit: {
      check: (tenantId, callerE164) =>
        rateLimiter.check(
          tenantId,
          RECOVERY_RATE_LIMIT_SCOPE,
          callerE164,
          RECOVERY_RATE_LIMIT_MAX,
          RECOVERY_RATE_LIMIT_WINDOW_MS,
        ),
      record: async (tenantId, callerE164) => {
        await rateLimiter.tryConsume(
          tenantId,
          RECOVERY_RATE_LIMIT_SCOPE,
          callerE164,
          RECOVERY_RATE_LIMIT_MAX,
          RECOVERY_RATE_LIMIT_WINDOW_MS,
        );
      },
    },
    resolvedSince: async (tenantId, voiceSessionId) => {
      const session = await input.voiceSessionRepo.findById(tenantId, voiceSessionId);
      if (!session?.outcome) return null;
      if (session.outcome === 'completed') return 'booking_completed';
      if (session.outcome === 'escalated_to_human') return 'transferred';
      return null;
    },
    compose: async ({ tenantId, contextCue, maxChars }) => {
      const result = await composeBrandVoiceMessage(
        {
          tenantId,
          intent: 'dropped_call_recovery_sms',
          context: contextCue ? { contextCue } : {},
          maxChars,
        },
        { gateway: input.gateway, settingsRepo: input.settingsRepo },
      );
      return result.text;
    },
    sendSms: async ({ tenantId, to, body, idempotencyKey }) => {
      const result = await input.delivery.sendSms({
        to,
        body,
        tenantId,
        idempotencyKey,
      });
      return result.providerMessageId;
    },
    ...(input.conversationLinkRepo
      ? {
          thread: async ({ tenantId, voiceSessionId, smsMessageSid }) => {
            const conversationId = smsMessageSid;
            await linkConversation(
              {
                tenantId,
                conversationId,
                entityType: 'voice_session',
                entityId: voiceSessionId,
              },
              input.conversationLinkRepo!,
            );
            await linkConversation(
              {
                tenantId,
                conversationId,
                entityType: 'sms_conversation',
                entityId: smsMessageSid,
              },
              input.conversationLinkRepo!,
            );
          },
        }
      : {}),
  };
}
