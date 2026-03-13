import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { VoiceRepository, TranscriptionProvider } from '../voice/voice-service';

export interface TranscriptionJobPayload {
  tenantId: string;
  recordingId: string;
  audioUrl: string;
  conversationId?: string;
}

export function createTranscriptionWorker(
  voiceRepository: VoiceRepository,
  transcriptionProvider: TranscriptionProvider
): WorkerHandler<TranscriptionJobPayload> {
  return {
    type: 'transcription',
    async handle(message: QueueMessage<TranscriptionJobPayload>, logger: Logger): Promise<void> {
      const { tenantId, recordingId, audioUrl, conversationId } = message.payload;

      logger.info('Starting transcription', { recordingId, conversationId });

      await voiceRepository.updateStatus(tenantId, recordingId, 'processing');

      try {
        const result = await transcriptionProvider.transcribe(audioUrl);

        await voiceRepository.updateStatus(tenantId, recordingId, 'completed', {
          transcript: result.transcript,
          metadata: result.metadata,
        });

        logger.info('Transcription completed', { recordingId });
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
