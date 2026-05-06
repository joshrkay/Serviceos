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

  // Transcription correction pass:
  //   1. Runs AFTER Whisper returns, BEFORE the router is notified.
  //   2. Uses the tenant glossary (when supplied) to disambiguate
  //      trade-specific terms and customer names.
  //   3. Falls back to the raw transcript on any failure — this is a
  //      quality upgrade, never a gate.
  //
  // The minimum-length floor is the P1-2 fix: short corrections
  // (e.g., a 1-char "y" for a 3-char "yes" raw) pass the 40%-of-raw
  // check but would be nonsense. `Math.max(MIN_CORRECTED_CHARS,
  // raw.length * 0.4)` catches that.
  describe('transcription correction fallback', () => {
    function fakeGateway(content: string) {
      return {
        complete: async () => ({
          content,
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }),
      } as any;
    }

    it('falls back to raw when correction is empty', async () => {
      const voiceRepo = new InMemoryVoiceRepository();
      const recording = createVoiceRecording({
        tenantId: 'tenant-1',
        fileId: 'file-1',
        createdBy: 'user-1',
      });
      await voiceRepo.create(recording);

      const worker = createTranscriptionWorker(
        voiceRepo,
        {
          async transcribe() {
            return { transcript: 'Install the PEX manifold on the water heater', metadata: {} };
          },
        },
        { gateway: fakeGateway('') }
      );

      const msg: QueueMessage<any> = {
        id: '1',
        type: 'transcription',
        payload: { tenantId: 'tenant-1', recordingId: recording.id, audioUrl: 'x' },
        attempts: 1,
        maxAttempts: 3,
        idempotencyKey: 'k',
        createdAt: new Date().toISOString(),
      };

      await worker.handle(msg, logger);
      const updated = await voiceRepo.findById('tenant-1', recording.id);
      // Raw transcript is preserved as canonical because correction
      // returned empty.
      expect(updated!.transcript).toBe('Install the PEX manifold on the water heater');
    });

    it('falls back when correction is below the absolute minimum length floor', async () => {
      const voiceRepo = new InMemoryVoiceRepository();
      const recording = createVoiceRecording({
        tenantId: 'tenant-1',
        fileId: 'file-2',
        createdBy: 'user-1',
      });
      await voiceRepo.create(recording);

      // Raw = "yes" (3 chars). 40% of raw = 1.2 — without the floor,
      // a 2-char correction would pass. The floor (4 chars) forces
      // fallback here.
      const worker = createTranscriptionWorker(
        voiceRepo,
        {
          async transcribe() {
            return { transcript: 'yes', metadata: {} };
          },
        },
        { gateway: fakeGateway('ok') }
      );

      const msg: QueueMessage<any> = {
        id: '2',
        type: 'transcription',
        payload: { tenantId: 'tenant-1', recordingId: recording.id, audioUrl: 'x' },
        attempts: 1,
        maxAttempts: 3,
        idempotencyKey: 'k2',
        createdAt: new Date().toISOString(),
      };

      await worker.handle(msg, logger);
      const updated = await voiceRepo.findById('tenant-1', recording.id);
      expect(updated!.transcript).toBe('yes');
    });

    it('keeps a valid correction and preserves raw-retention metadata + sanitization guardrails', async () => {
      const voiceRepo = new InMemoryVoiceRepository();
      const recording = createVoiceRecording({
        tenantId: 'tenant-1',
        fileId: 'file-3',
        createdBy: 'user-1',
      });
      await voiceRepo.create(recording);

      const raw = 'create invoice for picks plumbing for 450 dollars';
      const corrected = 'create invoice for PEX Plumbing for 450 dollars';
      const worker = createTranscriptionWorker(
        voiceRepo,
        {
          async transcribe() {
            return { transcript: raw, metadata: { provider: 'mock-whisper' } };
          },
        },
        {
          gateway: fakeGateway(corrected),
          glossary: {
            async termsForTenant() {
              return ['PEX Plumbing'];
            },
          },
        }
      );

      const msg: QueueMessage<any> = {
        id: '3',
        type: 'transcription',
        payload: { tenantId: 'tenant-1', recordingId: recording.id, audioUrl: 'x' },
        attempts: 1,
        maxAttempts: 3,
        idempotencyKey: 'k3',
        createdAt: new Date().toISOString(),
      };

      await worker.handle(msg, logger);
      const updated = await voiceRepo.findById('tenant-1', recording.id);
      expect(updated!.transcript).toBe(corrected);
      expect(updated!.transcriptMetadata?.sanitization_version).toBe('v1');
      expect(updated!.transcriptMetadata?.canonical_transcript_field).toBe('transcript');
      expect(updated!.transcriptMetadata?.prompt_rehydration_policy).toBe('sanitized_only');
      expect((updated!.transcriptMetadata?.raw_transcript_retention as any)?.ttl).toBe('P7D');
      expect((updated!.transcriptMetadata?.raw_transcript_retention as any)?.accessRole).toBe('voice_transcript_raw_reader');
      expect(updated!.transcriptMetadata?.correctionApplied).toBe(true);
      expect(updated!.transcriptMetadata?.glossaryTerms).toBe(1);
    });
  });

  describe('Phase 2 — outcome stamping', () => {
    it('stampOutcome sets the terminal-state enum', async () => {
      const repo = new InMemoryVoiceRepository();
      const recording = createVoiceRecording({
        tenantId: 'tenant-1',
        fileId: 'file-1',
        createdBy: 'user-1',
      });
      await repo.create(recording);

      const stamped = await repo.stampOutcome!('tenant-1', recording.id, 'escalated_to_human');
      expect(stamped?.outcome).toBe('escalated_to_human');
      const fetched = await repo.findById('tenant-1', recording.id);
      expect(fetched?.outcome).toBe('escalated_to_human');
    });

    it('stampOutcome returns null on tenant mismatch', async () => {
      const repo = new InMemoryVoiceRepository();
      const recording = createVoiceRecording({
        tenantId: 'tenant-1',
        fileId: 'file-1',
        createdBy: 'user-1',
      });
      await repo.create(recording);
      const stamped = await repo.stampOutcome!('tenant-2', recording.id, 'completed');
      expect(stamped).toBeNull();
    });

    it('stampOutcome can transition through outcomes (overwrite is intentional)', async () => {
      const repo = new InMemoryVoiceRepository();
      const recording = createVoiceRecording({
        tenantId: 'tenant-1',
        fileId: 'file-1',
        createdBy: 'user-1',
      });
      await repo.create(recording);
      await repo.stampOutcome!('tenant-1', recording.id, 'no_intent');
      const after = await repo.stampOutcome!('tenant-1', recording.id, 'completed');
      expect(after?.outcome).toBe('completed');
    });
  });
});
