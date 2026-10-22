import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createTranscriptionWorker,
  voicemailRouterEnqueueAllowed,
  voicemailJobContextFromPersisted,
} from '../../src/workers/transcription';
import type { VoiceRepository, TranscriptionProvider } from '../../src/voice/voice-service';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { QueueMessage } from '../../src/queues/queue';
import type { TranscriptionJobPayload } from '../../src/workers/transcription';
import { decrypt } from '../../src/integrations/crypto';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function makeVoiceRepo(): VoiceRepository {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(null),
    markCardNumberDetected: vi.fn().mockResolvedValue(undefined),
  } as unknown as VoiceRepository;
}

function makeMessage(overrides: Partial<TranscriptionJobPayload> = {}): QueueMessage<TranscriptionJobPayload> {
  return {
    id: 'msg-1',
    type: 'transcription',
    payload: {
      tenantId: 'tenant-1',
      recordingId: 'rec-1',
      audioUrl: 'https://example.com/audio.mp3',
      ...overrides,
    },
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'tenant-1:rec-1:transcription',
    createdAt: new Date().toISOString(),
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

describe('createTranscriptionWorker — RIVET I13 atomic provenance', () => {
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

  it("persists 'operator' in the same completion write for an authenticated in-app memo", async () => {
    const voiceRepo = repoWith('inapp_voice');
    await createTranscriptionWorker(voiceRepo, provider).handle(makeMessage(), logger);
    expect(voiceRepo.updateStatus).toHaveBeenCalledWith(
      'tenant-1',
      'rec-1',
      'completed',
      expect.objectContaining({
        metadata: expect.objectContaining({ provenance: 'operator' }),
      }),
    );
    expect(voiceRepo.stampProvenance).not.toHaveBeenCalled();
  });

  it("does NOT stamp 'operator' for a non-in-app recording (telephony/batch go elsewhere)", async () => {
    const voiceRepo = repoWith('inbound_call');
    await createTranscriptionWorker(voiceRepo, provider).handle(makeMessage(), logger);
    expect(voiceRepo.stampProvenance).not.toHaveBeenCalled();
  });

});

describe('createTranscriptionWorker — retry-visible status', () => {
  const failure = new Error('provider unavailable');
  const provider: TranscriptionProvider = {
    transcribe: vi.fn().mockRejectedValue(failure),
  };

  it('returns a retryable attempt to pending instead of exposing a terminal failure', async () => {
    const voiceRepo = makeVoiceRepo();
    await expect(
      createTranscriptionWorker(voiceRepo, provider).handle(
        { ...makeMessage(), attempts: 1, maxAttempts: 3 },
        logger,
      ),
    ).rejects.toThrow('provider unavailable');

    expect(voiceRepo.updateStatus).toHaveBeenLastCalledWith(
      'tenant-1',
      'rec-1',
      'pending',
      { error: 'provider unavailable' },
    );
  });

  it('exposes failed only after the final queue attempt', async () => {
    const voiceRepo = makeVoiceRepo();
    await expect(
      createTranscriptionWorker(voiceRepo, provider).handle(
        { ...makeMessage(), attempts: 3, maxAttempts: 3 },
        logger,
      ),
    ).rejects.toThrow('provider unavailable');

    expect(voiceRepo.updateStatus).toHaveBeenLastCalledWith(
      'tenant-1',
      'rec-1',
      'failed',
      { error: 'provider unavailable' },
    );
  });
});

describe('createTranscriptionWorker — U9 voicemail context threading', () => {
  const provider: TranscriptionProvider = {
    transcribe: vi
      .fn()
      .mockResolvedValue({ transcript: 'send Riley the quote we talked about', metadata: {} }),
  };

  it('threads the voicemail context (caller phone) into the completion event', async () => {
    const voiceRepo = makeVoiceRepo();
    const onTranscribed = vi.fn();
    const worker = createTranscriptionWorker(voiceRepo, provider, { onTranscribed });
    await worker.handle(
      makeMessage({ voicemail: { callerPhone: '+15125550100' } }),
      logger,
    );
    expect(onTranscribed).toHaveBeenCalledOnce();
    expect(onTranscribed.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      recordingId: 'rec-1',
      voicemail: { callerPhone: '+15125550100' },
    });
  });

  it('omits the voicemail key entirely for non-voicemail jobs (legacy events unchanged)', async () => {
    // #1231 — voicemail status is re-derived from the recording row, and a
    // missing row fails closed, so the in-app memo needs a row to be read.
    const voiceRepo = makeVoiceRepo();
    vi.mocked(voiceRepo.findById).mockResolvedValue({
      id: 'rec-1',
      tenantId: 'tenant-1',
      source: 'inapp_voice',
    } as never);
    const onTranscribed = vi.fn();
    const worker = createTranscriptionWorker(voiceRepo, provider, { onTranscribed });
    await worker.handle(makeMessage(), logger);
    expect(onTranscribed).toHaveBeenCalledOnce();
    expect('voicemail' in onTranscribed.mock.calls[0][0]).toBe(false);
  });
});

describe('#1223 — voicemailJobContextFromPersisted', () => {
  it('carries caller-ID and STIR/SHAKEN verdict from the voicemail webhook into the job', () => {
    expect(
      voicemailJobContextFromPersisted({ callerPhone: '+15125550100', stirVerstat: 'TN-Validation-Passed-A' }),
    ).toEqual({ callerPhone: '+15125550100', stirVerstat: 'TN-Validation-Passed-A' });
    expect(voicemailJobContextFromPersisted({})).toEqual({});
  });
});

describe('voicemailRouterEnqueueAllowed — U9 owner gate (router enqueue test)', () => {
  const gateLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  it('always allows non-voicemail events without consulting the approver check', async () => {
    const isApproverPhone = vi.fn();
    const allowed = await voicemailRouterEnqueueAllowed(
      { tenantId: 't-1', recordingId: 'rec-1' },
      { isApproverPhone },
      gateLogger,
    );
    expect(allowed).toBe(true);
    expect(isApproverPhone).not.toHaveBeenCalled();
  });

  it('allows a voicemail whose caller-ID is in the approver set', async () => {
    const isApproverPhone = vi.fn().mockResolvedValue(true);
    const allowed = await voicemailRouterEnqueueAllowed(
      {
        tenantId: 't-1',
        recordingId: 'rec-1',
        voicemail: { callerPhone: '+15125550100', stirVerstat: 'TN-Validation-Passed-A' },
      },
      { isApproverPhone },
      gateLogger,
    );
    expect(allowed).toBe(true);
    expect(isApproverPhone).toHaveBeenCalledWith('t-1', '+15125550100');
  });

  it.each(['TN-Validation-Passed-B', 'TN-Validation-Passed-C', 'No-TN-Validation', undefined])(
    '#1223 — blocks an approver caller-ID without A-attestation (StirVerstat=%s)',
    async (stirVerstat) => {
      const isApproverPhone = vi.fn().mockResolvedValue(true);
      const allowed = await voicemailRouterEnqueueAllowed(
        {
          tenantId: 't-1',
          recordingId: 'rec-1',
          voicemail: { callerPhone: '+15125550100', ...(stirVerstat ? { stirVerstat } : {}) },
        },
        { isApproverPhone },
        gateLogger,
      );
      expect(allowed).toBe(false);
    },
  );

  it('blocks an unknown caller (notify-only unchanged)', async () => {
    const isApproverPhone = vi.fn().mockResolvedValue(false);
    const allowed = await voicemailRouterEnqueueAllowed(
      { tenantId: 't-1', recordingId: 'rec-1', voicemail: { callerPhone: '+15550009999' } },
      { isApproverPhone },
      gateLogger,
    );
    expect(allowed).toBe(false);
  });

  it('forwards a MISSING caller phone (the approver check itself refuses undefined)', async () => {
    const isApproverPhone = vi.fn().mockResolvedValue(false);
    const allowed = await voicemailRouterEnqueueAllowed(
      { tenantId: 't-1', recordingId: 'rec-1', voicemail: { stirVerstat: 'TN-Validation-Passed-A' } },
      { isApproverPhone },
      gateLogger,
    );
    expect(allowed).toBe(false);
    expect(isApproverPhone).toHaveBeenCalledWith('t-1', undefined);
  });

  it('FAILS CLOSED when the approver lookup throws (degraded settings can never mint routing)', async () => {
    const isApproverPhone = vi.fn().mockRejectedValue(new Error('settings db down'));
    const allowed = await voicemailRouterEnqueueAllowed(
      {
        tenantId: 't-1',
        recordingId: 'rec-1',
        voicemail: { callerPhone: '+15125550100', stirVerstat: 'TN-Validation-Passed-A' },
      },
      { isApproverPhone },
      gateLogger,
    );
    expect(allowed).toBe(false);
  });
});

describe('createTranscriptionWorker — card numbers (PRIV-3)', () => {
  it('stores a voicemail transcript with a recited card number replaced', async () => {
    const voiceRepo = makeVoiceRepo();
    const transcriptionProvider: TranscriptionProvider = {
      transcribe: vi.fn().mockResolvedValue({
        transcript: 'Hi, please charge my card 4111 1111 1111 1111 for the visit.',
        metadata: {},
      }),
    };
    const worker = createTranscriptionWorker(voiceRepo, transcriptionProvider, {});
    await worker.handle(makeMessage(), logger);
    expect(voiceRepo.updateStatus).toHaveBeenCalledWith(
      'tenant-1',
      'rec-1',
      'completed',
      expect.objectContaining({
        transcript: 'Hi, please charge my card [card number] for the visit.',
      }),
    );
  });

  it('flags the recording for the prompt audio purge when the transcript carried a card number', async () => {
    const voiceRepo = makeVoiceRepo();
    const transcriptionProvider: TranscriptionProvider = {
      transcribe: vi.fn().mockResolvedValue({
        transcript: 'Hi, please charge my card 4111 1111 1111 1111 for the visit.',
        metadata: {},
      }),
    };
    const worker = createTranscriptionWorker(voiceRepo, transcriptionProvider, {});
    await worker.handle(makeMessage(), logger);
    expect(voiceRepo.markCardNumberDetected).toHaveBeenCalledTimes(1);
    expect(voiceRepo.markCardNumberDetected).toHaveBeenCalledWith('tenant-1', 'rec-1');
  });

  it('does not flag a voicemail with no card number', async () => {
    const voiceRepo = makeVoiceRepo();
    const transcriptionProvider: TranscriptionProvider = {
      transcribe: vi.fn().mockResolvedValue({
        transcript: 'Hi, call me back on 602 555 0199 about the visit.',
        metadata: {},
      }),
    };
    const worker = createTranscriptionWorker(voiceRepo, transcriptionProvider, {});
    await worker.handle(makeMessage(), logger);
    expect(voiceRepo.markCardNumberDetected).not.toHaveBeenCalled();
  });

  // Whisper writes a card read aloud as words; before the follow-up the words
  // went to the correction model, the stored transcript and the raw copy.
  describe('a card number Whisper wrote as words', () => {
    const SPOKEN_EN =
      'Hi, this is Ana. My card is four one one one, one one one one, one one one one, one one one one. Please call me back.';
    const SPOKEN_ES =
      'Hola, soy Ana. Mi tarjeta es cuatro uno uno uno uno uno uno uno uno uno uno uno uno uno uno uno, gracias.';
    const KEY = 'a'.repeat(64);

    const STORED_EN = 'Hi, this is Ana. My card is [card number]. Please call me back.';
    const STORED_ES = 'Hola, soy Ana. Mi tarjeta es [card number], gracias.';

    /** A correction model that returns the transcript it was meant to see. */
    function correctionGateway(corrected: string) {
      return {
        complete: vi.fn().mockResolvedValue({ content: corrected, model: 'mock' }),
      } as unknown as LLMGateway & { complete: ReturnType<typeof vi.fn> };
    }

    it('keeps the English words out of the correction prompt, the stored transcript and the raw copy, and flags the recording', async () => {
      const voiceRepo = makeVoiceRepo();
      const gateway = correctionGateway(STORED_EN);
      const worker = createTranscriptionWorker(
        voiceRepo,
        { transcribe: vi.fn().mockResolvedValue({ transcript: SPOKEN_EN, metadata: {} }) },
        { gateway, rawTranscriptEncryptionKey: KEY },
      );
      await worker.handle(makeMessage(), logger);

      const prompt = gateway.complete.mock.calls[0][0].messages[1].content as string;
      expect(prompt).toContain('My card is [card number]. Please call me back.');
      expect(prompt).not.toMatch(/four one one one|one one one one/);

      const [, , status, update] = (voiceRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect(status).toBe('completed');
      expect(update.transcript).toBe(STORED_EN);
      const retained = update.metadata.raw_transcript_retention as { encryptedBlob: string };
      expect(decrypt(retained.encryptedBlob, KEY)).toBe(STORED_EN);
      expect(voiceRepo.markCardNumberDetected).toHaveBeenCalledWith('tenant-1', 'rec-1');
    });

    it('keeps a Spanish card read as words out of the prompt and the stored transcript', async () => {
      const voiceRepo = makeVoiceRepo();
      const gateway = correctionGateway(STORED_ES);
      const worker = createTranscriptionWorker(
        voiceRepo,
        { transcribe: vi.fn().mockResolvedValue({ transcript: SPOKEN_ES, metadata: {} }) },
        { gateway },
      );
      await worker.handle(makeMessage(), logger);

      const prompt = gateway.complete.mock.calls[0][0].messages[1].content as string;
      expect(prompt).toContain('Mi tarjeta es [card number], gracias.');
      expect(prompt).not.toMatch(/cuatro uno|uno uno/);
      expect(voiceRepo.updateStatus).toHaveBeenCalledWith(
        'tenant-1',
        'rec-1',
        'completed',
        expect.objectContaining({ transcript: STORED_ES }),
      );
      expect(voiceRepo.markCardNumberDetected).toHaveBeenCalledWith('tenant-1', 'rec-1');
    });

    it('leaves a callback number read as words alone and does not flag the recording', async () => {
      const voiceRepo = makeVoiceRepo();
      const spoken = 'Please call me back at six oh two five five five oh one nine nine about the visit.';
      const worker = createTranscriptionWorker(
        voiceRepo,
        { transcribe: vi.fn().mockResolvedValue({ transcript: spoken, metadata: {} }) },
        {},
      );
      await worker.handle(makeMessage(), logger);
      expect(voiceRepo.updateStatus).toHaveBeenCalledWith(
        'tenant-1',
        'rec-1',
        'completed',
        expect.objectContaining({ transcript: spoken }),
      );
      expect(voiceRepo.markCardNumberDetected).not.toHaveBeenCalled();
    });
  });
});
