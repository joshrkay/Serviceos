import {
  validateVoiceIngest,
  createVoiceRecording,
  InMemoryVoiceRepository,
} from '../../src/voice/voice-service';
import { createTranscriptionWorker } from '../../src/workers/transcription';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';

describe('P0-012 — Voice ingestion and transcription pipeline', () => {
  const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

  it('happy path — creates voice recording', () => {
    const recording = createVoiceRecording({
      tenantId: 'tenant-1',
      fileId: 'file-1',
      conversationId: 'conv-1',
      createdBy: 'user-1',
    });

    expect(recording.id).toBeTruthy();
    expect(recording.status).toBe('pending');
    expect(recording.fileId).toBe('file-1');
  });

  it('happy path — transcription worker processes recording', async () => {
    const voiceRepo = new InMemoryVoiceRepository();
    const recording = createVoiceRecording({
      tenantId: 'tenant-1',
      fileId: 'file-1',
      createdBy: 'user-1',
    });
    await voiceRepo.create(recording);

    const mockProvider = {
      async transcribe() {
        return {
          transcript: 'Hello, this is a test.',
          metadata: { confidence: 0.95, language: 'en' },
        };
      },
    };

    const worker = createTranscriptionWorker(voiceRepo, mockProvider);

    const msg: QueueMessage<any> = {
      id: '1',
      type: 'transcription',
      payload: {
        tenantId: 'tenant-1',
        recordingId: recording.id,
        audioUrl: 'https://s3.example.com/audio.mp3',
      },
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: 'idem-1',
      createdAt: new Date().toISOString(),
    };

    await worker.handle(msg, logger);

    const updated = await voiceRepo.findById('tenant-1', recording.id);
    expect(updated!.status).toBe('completed');
    expect(updated!.transcript).toBe('Hello, this is a test.');
  });

  it('validation — rejects missing fileId', () => {
    const errors = validateVoiceIngest({
      tenantId: 'tenant-1',
      fileId: '',
      createdBy: 'user-1',
    });
    expect(errors).toContain('fileId is required');
  });

  it('validation — rejects invalid audio content type', () => {
    const errors = validateVoiceIngest(
      { tenantId: 'tenant-1', fileId: 'f1', createdBy: 'user-1' },
      'text/plain'
    );
    expect(errors.some((e) => e.includes('Invalid audio content type'))).toBe(true);
  });

  it('happy path — handles transcription failure', async () => {
    const voiceRepo = new InMemoryVoiceRepository();
    const recording = createVoiceRecording({
      tenantId: 'tenant-1',
      fileId: 'file-1',
      createdBy: 'user-1',
    });
    await voiceRepo.create(recording);

    const failingProvider = {
      async transcribe(): Promise<never> {
        throw new Error('Service unavailable');
      },
    };

    const worker = createTranscriptionWorker(voiceRepo, failingProvider);
    const msg: QueueMessage<any> = {
      id: '1',
      type: 'transcription',
      payload: {
        tenantId: 'tenant-1',
        recordingId: recording.id,
        audioUrl: 'https://s3.example.com/audio.mp3',
      },
      attempts: 1,
      maxAttempts: 3,
      idempotencyKey: 'idem-1',
      createdAt: new Date().toISOString(),
    };

    await expect(worker.handle(msg, logger)).rejects.toThrow('Service unavailable');

    const updated = await voiceRepo.findById('tenant-1', recording.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.errorMessage).toBe('Service unavailable');
  });
});
