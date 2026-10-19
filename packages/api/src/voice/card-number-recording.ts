/**
 * PRIV-3 — flag a recording on which a card number was said.
 *
 * The stored transcript only ever carries the `[card number]` marker
 * (`ai/privacy/pan-redact.ts`, applied in `callerTranscriptText` and the
 * transcription worker's `sanitizeTranscript`), but the audio still holds the
 * digits. Flagging the row `pci_detected` (migration 314) makes the
 * recording-retention sweep delete its stored audio promptly instead of at
 * the tenant's horizon.
 *
 * Two callers, one per way a recording gets a transcript:
 *   - `createRecordingTranscriptHook` (a live call's turns, at the recording
 *     webhook),
 *   - `createTranscriptionWorker` (a voicemail or memo transcribed later).
 *
 * Failure-soft: the transcript is already stored by the time this runs, and
 * neither caller may fail on it. A failed write is logged as an error so the
 * missed flag is visible. The audit event is written only by the write that
 * set the flag, so a webhook retry or queue redelivery never duplicates it.
 */
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { Logger } from '../logging/logger';
import type { VoiceRepository } from './voice-service';

export const CARD_NUMBER_DETECTED_EVENT = 'voice_recording.card_number_detected';

export interface FlagCardNumberRecordingDeps {
  voiceRepo: Pick<VoiceRepository, 'markCardNumberDetected'>;
  auditRepo?: Pick<AuditRepository, 'create'>;
  logger: Pick<Logger, 'error'>;
}

export async function flagCardNumberRecording(
  deps: FlagCardNumberRecordingDeps,
  args: {
    tenantId: string;
    voiceRecordingId: string;
    actorId: string;
    /** Which transcript carried the marker. */
    source: 'call_transcript' | 'recording_transcript';
  },
): Promise<void> {
  const { tenantId, voiceRecordingId } = args;
  let flagged: boolean;
  try {
    flagged = await deps.voiceRepo.markCardNumberDetected(tenantId, voiceRecordingId);
  } catch (err) {
    deps.logger.error('card number on recording: flag write failed; audio kept until the retention horizon', {
      tenantId,
      voiceRecordingId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!flagged || !deps.auditRepo) return;
  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: args.actorId,
        actorRole: 'system',
        eventType: CARD_NUMBER_DETECTED_EVENT,
        entityType: 'voice_recording',
        entityId: voiceRecordingId,
        metadata: { source: args.source },
      }),
    );
  } catch (err) {
    deps.logger.error('card number on recording: audit write failed', {
      tenantId,
      voiceRecordingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
