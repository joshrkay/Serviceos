import { describe, it, expect, vi } from 'vitest';
import { createTranscriptIngestionWorker } from '../../src/workers/transcript-ingestion-worker';
import { InMemoryCallTranscriptTurnRepository } from '../../src/voice/call-transcript-turn';
import { InMemoryVoiceRepository, createVoiceRecording } from '../../src/voice/voice-service';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  InMemoryKnowledgeChunkRepository,
} from '../../src/ai/training/knowledge-chunks';
import type {
  EmbeddingProvider,
  EmbeddingResult,
} from '../../src/ai/providers/openai-compatible';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

function unitVec(dim: number, fn: (i: number) => number): number[] {
  const raw = Array.from({ length: dim }, (_, i) => fn(i));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / (norm || 1));
}

// Constant unit vector so cosine similarity against the test query
// (also a unit vector of all-1s) is positive and chunks pass the
// repo's minSimilarity floor regardless of input string.
const CONST_EMBEDDING = unitVec(EMBEDDING_DIMENSIONS, () => 1);

function stubEmbedder(opts: { fail?: boolean } = {}): EmbeddingProvider & {
  callCount: () => number;
} {
  let calls = 0;
  return {
    name: 'stub',
    callCount: () => calls,
    async createEmbedding(_input: string): Promise<EmbeddingResult> {
      calls++;
      if (opts.fail) throw new Error('embedder stubbed to fail');
      return {
        embedding: [...CONST_EMBEDDING],
        model: EMBEDDING_MODEL,
        tokenUsage: 10,
        latencyMs: 1,
      };
    },
  };
}

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function buildMessage(payload: Record<string, unknown>): QueueMessage<any> {
  return {
    id: 'msg-1',
    type: 'transcript_ingestion',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'idem-1',
    createdAt: new Date().toISOString(),
  };
}

async function seedRecording(
  voiceRepo: InMemoryVoiceRepository,
): Promise<string> {
  const rec = createVoiceRecording({
    tenantId: TENANT_A,
    fileId: 'file-1',
    createdBy: 'user-1',
  });
  await voiceRepo.create(rec);
  return rec.id;
}

describe('transcript-ingestion-worker', () => {
  it('parses agent: / caller: prefixes and persists ordered turns', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const embeddings = stubEmbedder();
    const recordingId = await seedRecording(voiceRepo);

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings,
    });

    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        transcript: ['agent: hi how can I help', 'caller: my AC is broken', 'agent: when did it start'],
        summary: 'Customer reports broken AC',
        intent: 'create_appointment',
      }),
      logger,
    );

    const turns = await callTranscriptTurnRepo.listByRecording(TENANT_A, recordingId);
    expect(turns.map((t) => ({ speaker: t.speaker, text: t.text }))).toEqual([
      { speaker: 'agent', text: 'hi how can I help' },
      { speaker: 'caller', text: 'my AC is broken' },
      { speaker: 'agent', text: 'when did it start' },
    ]);
  });

  it('stamps voice_recordings.detected_language from the joined transcript when languageDetector is wired', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);
    const stampSpy = vi.spyOn(voiceRepo, 'stampDetectedLanguage');
    const { FrancLanguageDetector } = await import(
      '../../src/voice/language-detector'
    );

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
      languageDetector: new FrancLanguageDetector(),
    });

    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        // Long enough Spanish text to clear MIN_DETECTION_BYTES.
        transcript: [
          'agent: Hola buenos días en qué le puedo ayudar el día de hoy señor',
          'caller: Mi aire acondicionado no funciona puede enviar alguien para arreglarlo',
        ],
      }),
      logger,
    );

    expect(stampSpy).toHaveBeenCalledTimes(1);
    expect(stampSpy.mock.calls[0][2]).toBe('es');
    const stamped = await voiceRepo.findById(TENANT_A, recordingId);
    expect(stamped?.detectedLanguage).toBe('es');
  });

  it('skips language stamp when detector returns "und" (input too short)', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);
    const stampSpy = vi.spyOn(voiceRepo, 'stampDetectedLanguage');
    const { FrancLanguageDetector } = await import(
      '../../src/voice/language-detector'
    );

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
      languageDetector: new FrancLanguageDetector(),
    });

    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        transcript: ['agent: hi', 'caller: bye'],
      }),
      logger,
    );

    expect(stampSpy).not.toHaveBeenCalled();
  });

  it('skips language stamp when no detector is wired (Phase 4c off)', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);
    const stampSpy = vi.spyOn(voiceRepo, 'stampDetectedLanguage');

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
      // languageDetector intentionally omitted
    });

    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        transcript: [
          'agent: how can I help today',
          'caller: my air conditioner stopped working last night',
        ],
      }),
      logger,
    );

    expect(stampSpy).not.toHaveBeenCalled();
  });

  it('does NOT call stampOutcome when payload omits outcome (B2 no-op path)', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);
    const stampSpy = vi.spyOn(voiceRepo, 'stampOutcome');

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });

    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        transcript: ['agent: hi', 'caller: thanks'],
        // outcome intentionally omitted
      }),
      logger,
    );

    expect(stampSpy).not.toHaveBeenCalled();
  });

  it('stamps voice_recordings.outcome when provided', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });

    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        transcript: ['agent: hi', 'caller: bye'],
        outcome: 'escalated_to_human',
      }),
      logger,
    );

    const stamped = await voiceRepo.findById(TENANT_A, recordingId);
    expect(stamped?.outcome).toBe('escalated_to_human');
  });

  // ── RIVET I13 — Step 2c transcript provenance stamp ──────────────────────

  it('stamps provenance=mixed for a two-way call, from the real per-turn speakers', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);
    const stampSpy = vi.spyOn(voiceRepo, 'stampProvenance');

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });
    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        transcript: ['agent: hi how can I help', 'caller: my AC is broken'],
      }),
      logger,
    );

    // Explicit called-with assertion — never rely on absence checks here.
    expect(stampSpy).toHaveBeenCalledWith(TENANT_A, recordingId, 'mixed');
    const stamped = await voiceRepo.findById(TENANT_A, recordingId);
    expect((stamped?.transcriptMetadata as Record<string, unknown>)?.provenance).toBe('mixed');
  });

  it('stamps provenance=caller for caller-only turns and operator for agent-only', async () => {
    for (const [transcript, expected] of [
      [['caller: hello? anyone there?'], 'caller'],
      [['agent: note to self, order the capacitor'], 'operator'],
    ] as const) {
      const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
      const voiceRepo = new InMemoryVoiceRepository();
      const recordingId = await seedRecording(voiceRepo);
      const worker = createTranscriptIngestionWorker({
        callTranscriptTurnRepo,
        voiceRepo,
        knowledgeChunkRepo: new InMemoryKnowledgeChunkRepository(),
        embeddings: stubEmbedder(),
      });
      await worker.handle(
        buildMessage({
          tenantId: TENANT_A,
          voiceRecordingId: recordingId,
          transcript: [...transcript],
        }),
        logger,
      );
      const stamped = await voiceRepo.findById(TENANT_A, recordingId);
      expect((stamped?.transcriptMetadata as Record<string, unknown>)?.provenance).toBe(expected);
    }
  });

  it('provenance stamp is failure-soft: a throwing repo never fails the job', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const recordingId = await seedRecording(voiceRepo);
    vi.spyOn(voiceRepo, 'stampProvenance').mockRejectedValue(new Error('db down'));

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo: new InMemoryKnowledgeChunkRepository(),
      embeddings: stubEmbedder(),
    });
    await expect(
      worker.handle(
        buildMessage({
          tenantId: TENANT_A,
          voiceRecordingId: recordingId,
          transcript: ['agent: hi', 'caller: hello'],
        }),
        logger,
      ),
    ).resolves.not.toThrow();
    // The per-turn rows still landed despite the failed stamp.
    const turns = await callTranscriptTurnRepo.listByRecording(TENANT_A, recordingId);
    expect(turns.length).toBe(2);
  });

  it('skips the provenance stamp when there are no parseable turns', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const recordingId = await seedRecording(voiceRepo);
    const stampSpy = vi.spyOn(voiceRepo, 'stampProvenance');

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo: new InMemoryKnowledgeChunkRepository(),
      embeddings: stubEmbedder(),
    });
    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        transcript: ['   ', ''],
      }),
      logger,
    );
    expect(stampSpy).not.toHaveBeenCalled();
  });

  it('emits a per-call-summary chunk when summary/intent/outcome are present', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });

    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        transcript: ['agent: hi', 'caller: hello'],
        summary: 'Brief greeting',
        intent: 'small_talk',
        outcome: 'completed',
      }),
      logger,
    );

    const hits = await knowledgeChunkRepo.search({
      tenantId: TENANT_A,
      queryEmbedding: [...CONST_EMBEDDING],
      sourceTypes: ['call_summary'],
      minSimilarity: 0,
      k: 10,
    });
    const summary = hits.find((h) => h.chunk.sourceId === recordingId);
    expect(summary).toBeDefined();
    expect(summary!.chunk.contentScrubbed).toContain('Summary: Brief greeting');
    expect(summary!.chunk.contentScrubbed).toContain('Intent: small_talk');
    expect(summary!.chunk.contentScrubbed).toContain('Outcome: completed');
  });

  it('emits rolling-window chunks over the joined turn text', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);
    // Long transcript to force multiple windows. ~2000 chars total.
    const longText = 'lorem ipsum dolor sit amet '.repeat(80);
    const transcript = ['agent: ' + longText, 'caller: ' + longText];

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });

    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        transcript,
      }),
      logger,
    );

    // Sample query — we just want the row count, not relevance.
    const hits = await knowledgeChunkRepo.search({
      tenantId: TENANT_A,
      queryEmbedding: [...CONST_EMBEDDING],
      sourceTypes: ['transcript_window'],
      minSimilarity: 0,
      k: 50,
    });
    expect(hits.length).toBeGreaterThan(1);
    // Source IDs should follow ${recordingId}:${windowIndex}.
    expect(hits.every((h) => h.chunk.sourceId.startsWith(recordingId + ':'))).toBe(true);
  });

  it('idempotent under retry — second handle call upserts in place', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);
    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });
    const message = buildMessage({
      tenantId: TENANT_A,
      voiceRecordingId: recordingId,
      transcript: ['agent: hi', 'caller: hello'],
      summary: 'short',
    });

    await worker.handle(message, logger);
    await worker.handle(message, logger);

    const turns = await callTranscriptTurnRepo.listByRecording(TENANT_A, recordingId);
    expect(turns.length).toBe(2);
  });

  it('failure-soft: embedder error drops the chunk but does not throw', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder({ fail: true }),
    });

    await expect(
      worker.handle(
        buildMessage({
          tenantId: TENANT_A,
          voiceRecordingId: recordingId,
          transcript: ['agent: hi', 'caller: hello'],
          summary: 'short',
        }),
        logger,
      ),
    ).resolves.toBeUndefined();

    // Turns still persisted (Step 1 doesn't depend on embedder).
    const turns = await callTranscriptTurnRepo.listByRecording(TENANT_A, recordingId);
    expect(turns.length).toBe(2);
  });

  it('falls back to speaker=caller for unprefixed turns', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const knowledgeChunkRepo = new InMemoryKnowledgeChunkRepository();
    const recordingId = await seedRecording(voiceRepo);

    const worker = createTranscriptIngestionWorker({
      callTranscriptTurnRepo,
      voiceRepo,
      knowledgeChunkRepo,
      embeddings: stubEmbedder(),
    });

    await worker.handle(
      buildMessage({
        tenantId: TENANT_A,
        voiceRecordingId: recordingId,
        transcript: ['agent: hi', 'unprefixed thing', 'caller: hello'],
      }),
      logger,
    );

    const turns = await callTranscriptTurnRepo.listByRecording(TENANT_A, recordingId);
    expect(turns[1].speaker).toBe('caller');
    expect(turns[1].text).toBe('unprefixed thing');
  });
});
