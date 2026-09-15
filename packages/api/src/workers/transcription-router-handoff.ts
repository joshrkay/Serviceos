import type { Queue } from '../queues/queue';
import type { Logger } from '../logging/logger';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { VoiceActionRouterPayload } from './voice-action-router';
import {
  voicemailRouterEnqueueAllowed,
  type TranscriptionCompletionEvent,
} from './transcription';

export interface TranscriptionRouterHandoffDeps {
  queue: Pick<Queue, 'send'>;
  auditRepo: Pick<AuditRepository, 'create'>;
  /**
   * Tenant approver caller-ID check. Production wires `isApproverPhone`
   * from proposals/approver-identity.ts (owner_phone / backup supervisor).
   */
  isApproverPhone: (tenantId: string, phone: string | undefined) => Promise<boolean>;
}

/**
 * The transcription worker's `onTranscribed` hook: hands a completed
 * transcript to the voice-action-router queue. Lifted out of app.ts's
 * inline closure so the real hook can be driven end to end in tests.
 *
 * U9 — voicemail transcripts reach the action router ONLY when the
 * caller-ID matches the tenant's approver set (owner_phone / backup
 * supervisor — resolveOwnerSession precedent, fail-closed). Every other
 * caller keeps notify-only voicemail (lead + audit, no router).
 * Non-voicemail events (in-app memos) pass untouched.
 */
export function createTranscriptionRouterHandoff(
  deps: TranscriptionRouterHandoffDeps,
): (event: TranscriptionCompletionEvent, logger: Logger) => Promise<void> {
  return async (event, hookLogger) => {
    const routerAllowed = await voicemailRouterEnqueueAllowed(
      event,
      { isApproverPhone: deps.isApproverPhone },
      hookLogger,
    );
    if (event.voicemail) {
      // Audit the gate decision (repo invariant: new pipeline legs
      // audit). Best-effort — never blocks the enqueue path.
      try {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: event.tenantId,
            actorId: 'voicemail_webhook',
            actorRole: 'system',
            eventType: 'voicemail.router_gate',
            entityType: 'voice_recording',
            entityId: event.recordingId,
            metadata: {
              callerVerified: routerAllowed,
              enqueued: routerAllowed,
            },
          }),
        );
      } catch (auditErr) {
        hookLogger.warn('voicemail router gate audit failed', {
          recordingId: event.recordingId,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }
    }
    if (!routerAllowed) {
      hookLogger.info('voicemail transcript: caller not in approver set — notify-only', {
        recordingId: event.recordingId,
      });
      return;
    }
    // Enqueue the downstream voice-action-router job. A separate
    // poll loop picks it up and runs intent classification.
    // Keeping it on the queue instead of running inline means:
    //   1) transcription success isn't blocked by classifier latency
    //   2) router failures are retried by the queue, not stalled
    //   3) transcription and router workers can scale independently
    const routerPayload: VoiceActionRouterPayload = {
      tenantId: event.tenantId,
      userId: event.userId ?? 'system',
      transcript: event.transcript,
      conversationId: event.conversationId,
      recordingId: event.recordingId,
      ...(event.jobId ? { jobId: event.jobId } : {}),
      // U9 — the router stamps sourceContext.sourceChannel and force-
      // holds every voicemail-sourced proposal for human review
      // (holdIfUntrustedSource): the recording keeps untrusted
      // provenance (source='inbound_call'), so the owner caller-ID
      // gates only WHETHER this enqueue happens — never trust.
      ...(event.voicemail ? { sourceChannel: 'voicemail' as const } : {}),
    };
    await deps.queue.send(
      'voice_action_router',
      routerPayload,
      `${event.tenantId}:${event.recordingId}:voice_action_router`,
    );
    hookLogger.info('voice_action_router enqueued', {
      recordingId: event.recordingId,
      ...(event.voicemail ? { sourceChannel: 'voicemail' } : {}),
    });
  };
}
