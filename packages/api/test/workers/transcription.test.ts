import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTranscriptionWorker } from '../../src/workers/transcription';
import type { VoiceRepository, TranscriptionProvider } from '../../src/voice/voice-service';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { QueueMessage } from '../../src/queues/queue';
import type { TranscriptionJobPayload } from '../../src/workers/transcription';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function makeVoiceRepo(): VoiceRepository {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(null),
  } as unknown as VoiceRepository;
}

function makeMessage(overrides: Partial<TranscriptionJobPayload> = {}): QueueMessage<TranscriptionJobPayload> {
  return {
    id: 'msg-1',
    payload: {
      tenantId: 'tenant-1',
      recordingId: 'rec-1',
      audioUrl: 'https://example.com/audio.mp3',
      ...overrides,
    },
  } as unknown as QueueMessage<TranscriptionJobPayload>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createTranscriptionWorker — correction pass wiring', () => {
  it('runs the correction pass when gateway + glossary are present and stores the corrected transcript', async () => {
    const voiceRepo = makeVoiceRepo();
    const transcriptionProvider: TranscriptionProvider = {
      transcribe: vi.fn().mockResolvedValue({
        transcript: 'call the Hendersen job about the pecks pipe',
        metadata: {},
      }),
    };
    const gateway = {
      complete: vi.fn().mockResolvedValue({
        content: 'Call the Henderson job about the PEX pipe',
        model: 'mock-model',
      }),
    } as unknown as LLMGateway;
    const glossary = { termsForTenant: vi.fn().mockResolvedValue(['Henderson', 'PEX']) };

    const worker = createTranscriptionWorker(voiceRepo, transcriptionProvider, {
      gateway,
      glossary,
    });

    await worker.handle(makeMessage(), logger);

    expect(gateway.complete).toHaveBeenCalledTimes(1);
    const request = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.taskType).toBe('transcription_correction');
    // Top-level tenantId is required by the gateway's tenant-id guard.
    expect(request.tenantId).toBe('tenant-1');
    expect(request.messages[1].content).toContain('Henderson');
    expect(request.messages[1].content).toContain('PEX');

    expect(voiceRepo.updateStatus).toHaveBeenCalledWith(
      'tenant-1',
      'rec-1',
      'completed',
      expect.objectContaining({
        transcript: 'Call the Henderson job about the PEX pipe',
        metadata: expect.objectContaining({ correctionApplied: true, glossaryTerms: 2 }),
      })
    );
  });

  it('falls back to the raw transcript when the correction output fails the length guard', async () => {
    const voiceRepo = makeVoiceRepo();
    const raw = 'This is a reasonably long raw transcript from the technician about the job site visit today';
    const transcriptionProvider: TranscriptionProvider = {
      transcribe: vi.fn().mockResolvedValue({ transcript: raw, metadata: {} }),
    };
    const gateway = {
      // Suspiciously short vs. the raw input — should trip the < 40% guard.
      complete: vi.fn().mockResolvedValue({ content: 'ok', model: 'mock-model' }),
    } as unknown as LLMGateway;
    const glossary = { termsForTenant: vi.fn().mockResolvedValue([]) };

    const worker = createTranscriptionWorker(voiceRepo, transcriptionProvider, {
      gateway,
      glossary,
    });

    await worker.handle(makeMessage(), logger);

    expect(voiceRepo.updateStatus).toHaveBeenCalledWith(
      'tenant-1',
      'rec-1',
      'completed',
      expect.objectContaining({
        transcript: raw,
        metadata: expect.objectContaining({ correctionApplied: false }),
      })
    );
  });

  it('falls back to the raw transcript when the gateway call throws', async () => {
    const voiceRepo = makeVoiceRepo();
    const raw = 'raw transcript text';
    const transcriptionProvider: TranscriptionProvider = {
      transcribe: vi.fn().mockResolvedValue({ transcript: raw, metadata: {} }),
    };
    const gateway = {
      complete: vi.fn().mockRejectedValue(new Error('gateway unavailable')),
    } as unknown as LLMGateway;
    const glossary = { termsForTenant: vi.fn().mockResolvedValue(['Term']) };

    const worker = createTranscriptionWorker(voiceRepo, transcriptionProvider, {
      gateway,
      glossary,
    });

    await worker.handle(makeMessage(), logger);

    expect(voiceRepo.updateStatus).toHaveBeenCalledWith(
      'tenant-1',
      'rec-1',
      'completed',
      expect.objectContaining({ transcript: raw })
    );
  });

  it('skips the correction pass cleanly when no gateway is supplied (back-compat)', async () => {
    const voiceRepo = makeVoiceRepo();
    const raw = 'raw transcript, no gateway wired';
    const transcriptionProvider: TranscriptionProvider = {
      transcribe: vi.fn().mockResolvedValue({ transcript: raw, metadata: {} }),
    };

    const worker = createTranscriptionWorker(voiceRepo, transcriptionProvider, {});

    await worker.handle(makeMessage(), logger);

    expect(voiceRepo.updateStatus).toHaveBeenCalledWith(
      'tenant-1',
      'rec-1',
      'completed',
      expect.objectContaining({ transcript: raw })
    );
  });

  it('runs correction with an empty glossary when no glossary provider is supplied', async () => {
    const voiceRepo = makeVoiceRepo();
    const raw = 'raw transcript with generic trade terms only';
    const transcriptionProvider: TranscriptionProvider = {
      transcribe: vi.fn().mockResolvedValue({ transcript: raw, metadata: {} }),
    };
    const gateway = {
      complete: vi.fn().mockResolvedValue({
        content: 'Raw transcript with generic trade terms only, corrected',
        model: 'mock-model',
      }),
    } as unknown as LLMGateway;

    const worker = createTranscriptionWorker(voiceRepo, transcriptionProvider, { gateway });

    await worker.handle(makeMessage(), logger);

    const request = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.messages[1].content).not.toContain('Tenant-specific vocabulary');
    expect(request.messages[1].content).toContain(raw);
  });
});
