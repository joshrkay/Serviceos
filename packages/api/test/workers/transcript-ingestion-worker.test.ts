import { describe, it, expect, vi } from 'vitest';
import {
  createTranscriptIngestionWorker,
  type TranscriptIngestionTurn,
} from '../../src/workers/transcript-ingestion-worker';
import {
  InMemoryCallTranscriptTurnRepository,
  parseTranscriptLine,
} from '../../src/voice/call-transcript-turn';
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

/**
 * U8: the queue payload carries already-parsed turns with their append-time
 * index (what the recording hook builds from persisted rows or, as a
 * fallback, from the in-memory session). This mirrors the session fallback.
 */
function turnsFrom(lines: string[]): TranscriptIngestionTurn[] {
  return lines.map((line, index) => ({ index, ...parseTranscriptLine(line) }));
}

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
  it('persists ordered turns from the carried payload', async () => {
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
        turns: turnsFrom(['agent: hi how can I help', 'caller: my AC is broken', 'agent: when did it start']),
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

  // ── U8: persisted rows are authoritative; the worker upserts by carried index ──

  it('upserts each turn at its carried index, so end-of-call ingestion updates the rows persisted mid-call', async () => {
    const callTranscriptTurnRepo = new InMemoryCallTranscriptTurnRepository();
    const voiceRepo = new InMemoryVoiceRepository();
    const recordingId = await seedRecording(voiceRepo);
    // Mid-call persistence + attach already produced rows 0..2 for this recording.
    for (const [turnIndex, speaker, text] of [
      [0, 'agent', 'hi'],
      [1, 'caller', 'interim'],
      [2, 'agent', 'ok'],
    ] as const) {
      await callTranscriptTurnRepo.recordTurn({
        tenantId: TENANT_A, voiceRecordingId: recordingId, turnIndex, speaker, text,
      });
    }

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
        // Renumbered rows arrive with their own indices — NOT positional.
        turns: [
          { index: 0, speaker: 'agent', text: 'hi' },
          { index: 1, speaker: 'caller', text: 'final' },
          { index: 2, speaker: 'agent', text: 'ok' },
        ],
      }),
      logger,
    );

    const rows = await callTranscriptTurnRepo.listByRecording(TENANT_A, recordingId);
    expect(rows.map((r) => [r.turnIndex, r.text])).toEqual([
      [0, 'hi'],
      [1, 'final'],
      [2, 'ok'],
    ]);
  });

  it('a turn whose text is empty is skipped WITHOUT shifting the indices of later turns', async () => {
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
        turns: turnsFrom(['agent: hi', 'caller:   ', 'agent: still there?']),
      }),
      logger,
    );

    const rows = await callTranscriptTurnRepo.listByRecording(TENANT_A, recordingId);
    // Pre-U8 the worker filtered first and numbered the filtered array, so
    // 'still there?' landed at index 1 and fought with the mid-call row at 2.
    expect(rows.map((r) => [r.turnIndex, r.text])).toEqual([
      [0, 'hi'],
      [2, 'still there?'],
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
        turns: turnsFrom([
          'agent: Hola buenos días en qué le puedo ayudar el día de hoy señor',
          'caller: Mi aire acondicionado no funciona puede enviar alguien para arreglarlo',
        ]),
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
        turns: turnsFrom(['agent: hi', 'caller: bye']),
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
        turns: turnsFrom([
          'agent: how can I help today',
          'caller: my air conditioner stopped working last night',
        ]),
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
        turns: turnsFrom(['agent: hi', 'caller: thanks']),
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
        turns: turnsFrom(['agent: hi', 'caller: bye']),
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
        turns: turnsFrom(['agent: hi how can I help', 'caller: my AC is broken']),
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
          turns: turnsFrom([...transcript]),
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
          turns: turnsFrom(['agent: hi', 'caller: hello']),
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
        turns: turnsFrom(['   ', '']),
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
        turns: turnsFrom(['agent: hi', 'caller: hello']),
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
        turns: turnsFrom(transcript),
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
      turns: turnsFrom(['agent: hi', 'caller: hello']),
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
          turns: turnsFrom(['agent: hi', 'caller: hello']),
          summary: 'short',
        }),
        logger,
      ),
    ).resolves.toBeUndefined();

    // Turns still persisted (Step 1 doesn't depend on embedder).
    const turns = await callTranscriptTurnRepo.listByRecording(TENANT_A, recordingId);
    expect(turns.length).toBe(2);
  });
});
