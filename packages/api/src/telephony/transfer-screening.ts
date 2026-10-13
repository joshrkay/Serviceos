/**
 * H1 / H1-R (review of #1676) — the hand-off screen's effect on the live
 * session.
 *
 * Twilio cannot tell a person from a carrier voicemail answering the
 * dispatcher's phone: both are `answered` / DialCallStatus `completed`. Every
 * Dial leg is therefore screened (whisper-route.ts; the call control points
 * every /dial-result leg at it), and `onAccepted` turns the only trustworthy
 * signal — a person pressing 1 — into the session fact /dial-result and the
 * page ladder rely on: `transferAnsweredAt` on the live session, and durably
 * the TRANSFER_ANSWERED_EVENT audit row, which resolves the emergency page
 * ladder while the bridged call is still live — from any process.
 *
 * Tenant-checked against the escalation's tenant and the verifying credential's
 * tenant (#1072); never throws. The audit write is NOT awaited: the person who
 * pressed 1 is waiting for the bridge; a lost write only means the ladder keeps
 * paging (the safe direction) on processes that do not hold the live session.
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
  onAccepted(args: {
    sessionId: string;
    tenantId?: string;
    verifiedTenantId?: string;
    childCallSid?: string;
  }): Promise<void>;
}

export function createTransferScreenHooks(deps: {
  store: { peek(sessionId: string): VoiceSession | undefined };
  auditRepo?: AuditRepository;
}): TransferScreenHooks {
  const sessionFor = (
    sessionId: string,
    tenantId: string | undefined,
    verifiedTenantId: string | undefined,
  ): VoiceSession | undefined => {
    const session = deps.store.peek(sessionId);
    if (!session) return undefined;
    if (tenantId !== undefined && session.tenantId !== tenantId) return undefined;
    if (verifiedTenantId !== undefined && session.tenantId !== verifiedTenantId) return undefined;
    return session;
  };
  return {
    async onAccepted({ sessionId, tenantId, verifiedTenantId, childCallSid }) {
      const session = sessionFor(sessionId, tenantId, verifiedTenantId);
      if (!session || session.transferAnsweredAt !== undefined) return;
      session.transferAnsweredAt = Date.now();
      logger.info('hand-off accepted by a person (screen keypress)', { sessionId });
      if (!deps.auditRepo) return;
      void deps.auditRepo
        .create(
          createAuditEvent({
            tenantId: session.tenantId,
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
