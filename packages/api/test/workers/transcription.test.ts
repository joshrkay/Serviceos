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

  it('falls back to the raw transcript when the "corrected" output is JSON but the raw was not (defense-in-depth against a misconfigured/mock gateway)', async () => {
    const voiceRepo = makeVoiceRepo();
    // Long enough that a short JSON blob still clears the 40%-length floor
    // (this is the exact shape of the transcript-corruption bug: a
    // hermetic mock's scripted catch-all response replacing a real prose
    // transcript because it happens to pass the length guard).
    const raw =
      'Went out to the Henderson property this morning to check on the water heater before we replace it';
    const jsonBlob = JSON.stringify({
      ok: true,
      mock: true,
      taskType: 'transcription_correction',
      note: 'hermetic-mock',
    });
    // Sanity check this fixture actually exercises the scenario: the JSON
    // blob must be at least as long as the length floor, or the existing
    // length guard (not the new JSON guard) would be what rejects it.
    const floor = Math.max(4, Math.ceil(raw.length * 0.4));
    expect(jsonBlob.length).toBeGreaterThanOrEqual(floor);

    const transcriptionProvider: TranscriptionProvider = {
      transcribe: vi.fn().mockResolvedValue({ transcript: raw, metadata: {} }),
    };
    const gateway = {
      complete: vi.fn().mockResolvedValue({ content: jsonBlob, model: 'mock-model' }),
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
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('JSON for prose input'),
      expect.objectContaining({ rawLen: raw.length })
    );
  });

  it('does NOT reject a genuinely JSON-shaped correction when the raw transcript was also JSON-shaped', async () => {
    const voiceRepo = makeVoiceRepo();
    const raw = '{"note": "customer said replace the valve"}';
    const corrected = '{"note": "customer said replace the valve, PEX pipe"}';
    const transcriptionProvider: TranscriptionProvider = {
      transcribe: vi.fn().mockResolvedValue({ transcript: raw, metadata: {} }),
    };
    const gateway = {
      complete: vi.fn().mockResolvedValue({ content: corrected, model: 'mock-model' }),
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
      expect.objectContaining({ transcript: corrected })
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

describe('createTranscriptionWorker — RIVET I13 provenance stamp (Codex)', () => {
  function repoWith(source: string | undefined): VoiceRepository & {
    stampProvenance: ReturnType<typeof vi.fn>;
  } {
    return {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue(source ? { id: 'rec-1', source } : { id: 'rec-1' }),
      updateStatus: vi.fn().mockResolvedValue(null),
      stampProvenance: vi.fn().mockResolvedValue(null),
    } as unknown as VoiceRepository & { stampProvenance: ReturnType<typeof vi.fn> };
  }
  const provider: TranscriptionProvider = {
    transcribe: vi.fn().mockResolvedValue({ transcript: 'note to self, order the capacitor', metadata: {} }),
  };

  it("stamps 'operator' for an authenticated in-app memo (source='inapp_voice')", async () => {
    const voiceRepo = repoWith('inapp_voice');
    await createTranscriptionWorker(voiceRepo, provider).handle(makeMessage(), logger);
    expect(voiceRepo.stampProvenance).toHaveBeenCalledWith('tenant-1', 'rec-1', 'operator');
  });

  it("does NOT stamp 'operator' for a non-in-app recording (telephony/batch go elsewhere)", async () => {
    const voiceRepo = repoWith('inbound_call');
    await createTranscriptionWorker(voiceRepo, provider).handle(makeMessage(), logger);
    expect(voiceRepo.stampProvenance).not.toHaveBeenCalled();
  });

  it('is failure-soft: a stamp error never fails transcription', async () => {
    const voiceRepo = repoWith('inapp_voice');
    voiceRepo.stampProvenance.mockRejectedValueOnce(new Error('db down'));
    await expect(
      createTranscriptionWorker(voiceRepo, provider).handle(makeMessage(), logger),
    ).resolves.not.toThrow();
    // Transcription still completed.
    expect(voiceRepo.updateStatus).toHaveBeenCalledWith(
      'tenant-1',
      'rec-1',
      'completed',
      expect.anything(),
    );
  });
});
