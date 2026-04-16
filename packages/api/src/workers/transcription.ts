import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { VoiceRepository, TranscriptionProvider } from '../voice/voice-service';

export interface TranscriptionJobPayload {
  tenantId: string;
  recordingId: string;
  audioUrl: string;
  conversationId?: string;
  /**
   * The user whose session produced the voice recording. Required when
   * downstream consumers (voice-action-router) need to create proposals
   * attributed to a human. Optional to preserve backward compatibility
   * with older queue messages.
   */
  userId?: string;
}

export interface TranscriptionCompletionEvent {
  tenantId: string;
  recordingId: string;
  transcript: string;
  conversationId?: string;
  userId?: string;
}

export interface CreateTranscriptionWorkerOptions {
  /**
   * Fired after a successful transcription is persisted. Used to hand
   * the transcript off to the voice-action-router which enqueues a
   * downstream job. The callback failing does NOT fail the transcription —
   * the transcript is already safely stored, and router errors are
   * recoverable via retry on their own queue.
   */
  onTranscribed?: (event: TranscriptionCompletionEvent, logger: Logger) => Promise<void> | void;
}

export function createTranscriptionWorker(
  voiceRepository: VoiceRepository,
  transcriptionProvider: TranscriptionProvider,
  options: CreateTranscriptionWorkerOptions = {}
): WorkerHandler<TranscriptionJobPayload> {
  return {
    type: 'transcription',
    async handle(message: QueueMessage<TranscriptionJobPayload>, logger: Logger): Promise<void> {
      const { tenantId, recordingId, audioUrl, conversationId, userId } = message.payload;

      logger.info('Starting transcription', { recordingId, conversationId });

      await voiceRepository.updateStatus(tenantId, recordingId, 'processing');

      try {
        const result = await transcriptionProvider.transcribe(audioUrl);

        await voiceRepository.updateStatus(tenantId, recordingId, 'completed', {
          transcript: result.transcript,
          metadata: result.metadata,
        });

        logger.info('Transcription completed', { recordingId });

        if (options.onTranscribed && result.transcript) {
          try {
            await options.onTranscribed(
              {
                tenantId,
                recordingId,
                transcript: result.transcript,
                conversationId,
                userId,
              },
              logger
            );
          } catch (hookErr) {
            // Hook errors must not fail the transcription — the transcript is
            // already persisted. Log and swallow so the queue doesn't retry a
            // transcription that already succeeded.
            const error = hookErr instanceof Error ? hookErr : new Error(String(hookErr));
            logger.error('Transcription onTranscribed hook failed', {
              recordingId,
              error: error.message,
            });
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error('Transcription failed', { recordingId, error: error.message });

        await voiceRepository.updateStatus(tenantId, recordingId, 'failed', {
          error: error.message,
        });

        throw err;
      }
    },
  };
}
