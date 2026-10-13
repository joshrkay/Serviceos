/**
 * H1 (review of #1676) — the hand-off screen's effect on the live session.
 *
 * Twilio cannot tell a person from a carrier voicemail answering the
 * dispatcher's phone: both are `answered` / DialCallStatus `completed`. The
 * whisper is therefore a screen (whisper-route.ts), and these hooks turn its
 * two outcomes into session facts:
 *   - `onScreenOffered` — the screen played for this hand-off, so from now on
 *     only an acceptance counts as answered (/dial-result stops trusting a
 *     bare `completed` for it);
 *   - `onAccepted` — a human pressed 1: the hand-off is answered. Recorded on
 *     the live session (`transferAnsweredAt`) and durably as the
 *     TRANSFER_ANSWERED_EVENT audit row, which is what resolves the emergency
 *     page ladder while the bridged call is still live — from any process.
 *
 * Both are tenant-checked against the escalation's own tenant and never
 * throw. The audit write is NOT awaited: the person who pressed 1 is waiting
 * for the bridge; a lost write only means the ladder keeps paging (the safe
 * direction) on processes that do not hold the live session.
 */
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { VoiceSession } from '../ai/agents/customer-calling/voice-session-store';
import { TRANSFER_ANSWERED_EVENT } from './emergency-page-retry';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'telephony.transfer-screening',
  environment: process.env.NODE_ENV || 'development',
});

export interface TransferScreenHooks {
  onScreenOffered(args: { sessionId: string; tenantId: string }): void;
  onAccepted(args: { sessionId: string; tenantId: string; childCallSid?: string }): Promise<void>;
}

export function createTransferScreenHooks(deps: {
  store: { peek(sessionId: string): VoiceSession | undefined };
  auditRepo?: AuditRepository;
}): TransferScreenHooks {
  const sessionFor = (sessionId: string, tenantId: string): VoiceSession | undefined => {
    const session = deps.store.peek(sessionId);
    return session && session.tenantId === tenantId ? session : undefined;
  };
  return {
    onScreenOffered({ sessionId, tenantId }) {
      const session = sessionFor(sessionId, tenantId);
      if (session) session.transferScreenOffered = true;
    },
    async onAccepted({ sessionId, tenantId, childCallSid }) {
      const session = sessionFor(sessionId, tenantId);
      if (!session || session.transferAnsweredAt !== undefined) return;
      session.transferAnsweredAt = Date.now();
      logger.info('hand-off accepted by a person (screen keypress)', { sessionId });
      if (!deps.auditRepo) return;
      void deps.auditRepo
        .create(
          createAuditEvent({
            tenantId,
            actorId: 'system:telephony',
            actorRole: 'system',
            eventType: TRANSFER_ANSWERED_EVENT,
            entityType: 'voice_session',
            entityId: sessionId,
            correlationId: sessionId,
            metadata: {
              ...(childCallSid ? { childCallSid } : {}),
              ...(session.callSid ? { callSid: session.callSid } : {}),
              via: 'screen_keypress',
            },
          }),
        )
        .catch((err: unknown) => {
          logger.warn('transfer-answered audit write failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
  };
}
