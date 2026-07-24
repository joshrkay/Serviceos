import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { CallTranscriptTurnRepository, CallTurnSpeaker } from '../voice/call-transcript-turn';
import { CallOutcome, VoiceRepository } from '../voice/voice-service';
import type { LanguageDetector } from '../voice/language-detector';
import {
  EMBEDDING_MODEL,
  KnowledgeChunkRepository,
  KnowledgeChunkSourceType,
} from '../ai/training/knowledge-chunks';
import { EmbeddingProvider } from '../ai/providers/openai-compatible';
import { KnownEntities, scrubPii } from '../ai/training/scrub';
import { classifyTranscriptTurnProvenance } from '../ai/content-provenance';

/**
 * transcript-ingestion-worker — Phase 4a-1 of the inbound-CSR RAG
 * architecture (writers).
 *
 * Triggered at `_endSessionLocked` time by both the in-app and Twilio
 * adapters, after `summarizeSession` has written its `call_summaries`
 * row. Performs four atomic-ish operations:
 *
 *   1. Persists per-turn rows into `call_transcript_turns` so the
 *      in-memory FSM transcript survives process restarts and the
 *      retrieval-side surface (Phase 4a-2) has stable input. Idempotent
 *      via `(voice_recording_id, turn_index)` ON CONFLICT.
 *
 *   2. Stamps `voice_recordings.outcome` (terminal-state enum) when the
 *      FSM provided one in the payload. Optional — older payloads /
 *      backfill jobs may omit it.
 *
 *   3. Emits a per-call-summary chunk into `knowledge_chunks` combining
 *      `summary + intent + outcome`. Source type `'call_summary'`,
 *      source_id is the voice_recording_id.
 *
 *   4. Emits rolling-window chunks (~200 tokens, 50 overlap) over the
 *      concatenated turn text. Source type `'transcript_window'`,
 *      source_id is `${voice_recording_id}:${windowIndex}`.
 *
 * Failure-soft: per-step errors logged but don't fail the whole job
 * unless they're the kind that retry helps (e.g. embedding rate
 * limit). Both `call_transcript_turns` and `knowledge_chunks` upsert
 * cleanly so a partial failure followed by retry converges to the
 * full intended state without duplicates.
 *
 * No PR-#227 dep on the FSM yet: this worker is the FIRST writer to
 * `knowledge_chunks` in production. Until 4a-2 lands the reader, the
 * corpus simply accumulates.
 */

export interface TranscriptIngestionPayload {
  tenantId: string;
  voiceRecordingId: string;
  /**
   * Speaker-prefixed turns from `VoiceSessionStore.transcript`. Format:
   * `["agent: greeting", "caller: hi", ...]`. Anything without a
   * recognised prefix is recorded as `speaker='caller'` to preserve
   * the row but flagged in the worker logs.
   */
  transcript: string[];
  /** From `call_summaries.summary` — the 3-sentence LLM summary. */
  summary?: string;
  /** From `call_summaries.detected_intent`. */
  intent?: string;
  /** Stamped onto `voice_recordings.outcome` if provided. */
  outcome?: CallOutcome;
  /** Wall-clock duration of the session, used as embedding metadata only. */
  durationMs?: number;
  /**
   * Known caller PII for the entity-based scrub layer. The adapter
   * looks these up from customers/locations/appointments and passes
   * them in so the scrubber doesn't need DB access.
   */
  knownEntities?: KnownEntities;
}

export interface TranscriptIngestionDeps {
  callTranscriptTurnRepo: CallTranscriptTurnRepository;
  voiceRepo: VoiceRepository;
  knowledgeChunkRepo: KnowledgeChunkRepository;
  embeddings: EmbeddingProvider;
  /**
   * Phase 4c language detector. Optional — when omitted the worker
   * skips the `voice_recordings.detected_language` stamp and the
   * column stays NULL (treated as "unknown" by dashboards).
   */
  languageDetector?: LanguageDetector;
}

// Rough token estimation: 4 chars ≈ 1 token. 200-token window ≈ 800
// chars; 50-token overlap ≈ 200 chars. Per the approved Phase 1 plan,
// these are tunable once we have real volume; v1 picks reasonable
// defaults for English transcripts.
const WINDOW_SIZE_CHARS = 800;
const WINDOW_OVERLAP_CHARS = 200;

const SUMMARY_SOURCE_TYPE: KnowledgeChunkSourceType = 'call_summary';
const WINDOW_SOURCE_TYPE: KnowledgeChunkSourceType = 'transcript_window';

interface ParsedTurn {
  speaker: CallTurnSpeaker;
  text: string;
}

/**
 * Parse "agent: hi" / "caller: hello" prefixes. Falls back to
 * speaker='caller' for unprefixed lines so a single weird turn
 * doesn't drop the whole transcript.
 */
function parseTurn(raw: string): ParsedTurn {
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const prefix = raw.slice(0, colon).trim().toLowerCase();
    const text = raw.slice(colon + 1).trim();
    if (prefix === 'agent' || prefix === 'caller') {
      return { speaker: prefix, text };
    }
  }
  return { speaker: 'caller', text: raw.trim() };
}

/**
 * Slice the joined transcript into overlapping windows. Windows snap
 * to whitespace where possible to avoid mid-word cuts that would
 * hurt embedding quality. Always emits at least one window if the
 * input is non-empty.
 */
function buildWindows(text: string): string[] {
  if (text.length === 0) return [];
  if (text.length <= WINDOW_SIZE_CHARS) return [text];

  const windows: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + WINDOW_SIZE_CHARS, text.length);
    let cut = end;
    // Prefer a whitespace boundary inside the last 100 chars of the window.
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > start && end - lastSpace < 100) cut = lastSpace;
    }
    windows.push(text.slice(start, cut).trim());
    if (cut >= text.length) break;
    start = Math.max(cut - WINDOW_OVERLAP_CHARS, start + 1);
  }
  return windows.filter((w) => w.length > 0);
}

/**
 * Build the per-call-summary chunk text. Combines the LLM summary
 * with the inferred intent and the FSM-stamped outcome so a single
 * top-similarity hit gives the LLM enough context to ground its
 * response without pulling additional chunks.
 */
function buildSummaryChunkText(
  summary: string | undefined,
  intent: string | undefined,
  outcome: CallOutcome | undefined,
): string {
  const parts: string[] = [];
  if (summary && summary.trim().length > 0) parts.push(`Summary: ${summary.trim()}`);
  if (intent && intent.trim().length > 0) parts.push(`Intent: ${intent.trim()}`);
  if (outcome) parts.push(`Outcome: ${outcome}`);
  return parts.join('\n');
}

export function createTranscriptIngestionWorker(
  deps: TranscriptIngestionDeps,
): WorkerHandler<TranscriptIngestionPayload> {
  return {
    type: 'transcript_ingestion',
    async handle(
      message: QueueMessage<TranscriptIngestionPayload>,
      logger: Logger,
    ): Promise<void> {
      const { tenantId, voiceRecordingId, transcript, summary, intent, outcome, knownEntities } =
        message.payload;

      logger.info('Starting transcript ingestion', {
        voiceRecordingId,
        turnCount: transcript.length,
        hasSummary: !!summary,
        hasOutcome: !!outcome,
      });

      // ── Step 1: persist per-turn rows ──────────────────────────────────
      const turns = transcript.map(parseTurn).filter((t) => t.text.length > 0);
      let unprefixed = 0;
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        if (turn.speaker === 'caller' && !transcript[i].toLowerCase().startsWith('caller:')) {
          unprefixed++;
        }
        try {
          await deps.callTranscriptTurnRepo.recordTurn({
            tenantId,
            voiceRecordingId,
            turnIndex: i,
            speaker: turn.speaker,
            text: turn.text,
          });
        } catch (err) {
          // Per-turn errors are logged but don't poison the whole job;
          // the upsert path makes retry safe.
          const error = err instanceof Error ? err : new Error(String(err));
          logger.warn('recordTurn failed', {
            voiceRecordingId,
            turnIndex: i,
            error: error.message,
          });
        }
      }
      if (unprefixed > 0) {
        logger.warn('transcript turns missing speaker prefix', {
          voiceRecordingId,
          unprefixedCount: unprefixed,
        });
      }

      // ── Step 2: stamp the outcome enum ────────────────────────────────
      if (outcome && deps.voiceRepo.stampOutcome) {
        try {
          await deps.voiceRepo.stampOutcome(tenantId, voiceRecordingId, outcome);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.warn('stampOutcome failed', { voiceRecordingId, outcome, error: error.message });
        }
      }

      // ── Step 2b (Phase 4c): detect language and stamp the recording ──
      // We run detection on the joined transcript (highest-signal input
      // available — the per-window text is the same join, just sliced).
      // Stamp NULL when detection returns 'und' or no detector is wired;
      // the column already defaults to NULL so a no-op is safe.
      const joinedTranscript = turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
      if (deps.languageDetector && deps.voiceRepo.stampDetectedLanguage) {
        const detection = deps.languageDetector.detect(joinedTranscript);
        if (detection.language !== 'und') {
          try {
            await deps.voiceRepo.stampDetectedLanguage(
              tenantId,
              voiceRecordingId,
              detection.language,
            );
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            logger.warn('stampDetectedLanguage failed', {
              voiceRecordingId,
              language: detection.language,
              error: error.message,
            });
          }
        }
      }

      // ── Step 2c (RIVET I13): stamp transcript provenance ──────────────
      // Compute 'caller' | 'mixed' | 'operator' from the REAL per-turn
      // speaker distribution (never guessed from a joined string) and merge
      // it into transcript_metadata so readers can classify the recording
      // via classifyRecordingProvenance — which fails closed, so a missing
      // stamp means untrusted. Failure-soft like the sibling stamps: a stamp
      // error never fails the ingestion job.
      if (turns.length > 0 && deps.voiceRepo.stampProvenance) {
        const hasCaller = turns.some(
          (t) => classifyTranscriptTurnProvenance(t) === 'untrusted',
        );
        const hasAgent = turns.some(
          (t) => classifyTranscriptTurnProvenance(t) === 'trusted',
        );
        const provenance = hasCaller && hasAgent ? 'mixed' : hasCaller ? 'caller' : 'operator';
        try {
          await deps.voiceRepo.stampProvenance(tenantId, voiceRecordingId, provenance);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.warn('stampProvenance failed', {
            voiceRecordingId,
            provenance,
            error: error.message,
          });
        }
      }

      // ── Step 3: per-call-summary chunk ─────────────────────────────────
      const summaryText = buildSummaryChunkText(summary, intent, outcome);
      if (summaryText.length > 0) {
        await emitChunk({
          tenantId,
          sourceType: SUMMARY_SOURCE_TYPE,
          sourceId: voiceRecordingId,
          rawText: summaryText,
          metadata: { intent, outcome, voiceRecordingId },
          knownEntities,
          deps,
          logger,
        });
      }

      // ── Step 4: rolling-window chunks ──────────────────────────────────
      const windows = buildWindows(joinedTranscript);
      for (let i = 0; i < windows.length; i++) {
        await emitChunk({
          tenantId,
          sourceType: WINDOW_SOURCE_TYPE,
          sourceId: `${voiceRecordingId}:${i}`,
          rawText: windows[i],
          metadata: { voiceRecordingId, windowIndex: i, windowCount: windows.length },
          knownEntities,
          deps,
          logger,
        });
      }

      logger.info('Transcript ingestion complete', {
        voiceRecordingId,
        turnsRecorded: turns.length,
        chunksEmitted: (summaryText.length > 0 ? 1 : 0) + windows.length,
      });
    },
  };
}

interface EmitChunkInput {
  tenantId: string;
  sourceType: KnowledgeChunkSourceType;
  sourceId: string;
  rawText: string;
  metadata: Record<string, unknown>;
  knownEntities?: KnownEntities;
  deps: TranscriptIngestionDeps;
  logger: Logger;
}

/**
 * Scrub → embed → upsert. Failure-soft per chunk: a single embedding
 * failure (rate limit, transient network) logs and skips that chunk;
 * the queue's retry will re-emit on the next attempt and the
 * `knowledge_chunks` ON CONFLICT semantics make that safe.
 */
async function emitChunk(input: EmitChunkInput): Promise<void> {
  const { tenantId, sourceType, sourceId, rawText, metadata, knownEntities, deps, logger } = input;

  const scrub = scrubPii(rawText, { knownEntities });
  if (scrub.scrubbed.length === 0) {
    logger.warn('chunk scrubbed to empty; skipping', { sourceType, sourceId });
    return;
  }

  let embedding;
  try {
    const result = await deps.embeddings.createEmbedding(scrub.scrubbed);
    embedding = result.embedding;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn('embedding failed; skipping chunk', {
      sourceType,
      sourceId,
      error: error.message,
    });
    return;
  }

  try {
    await deps.knowledgeChunkRepo.insert({
      tenantId,
      scope: 'tenant',
      sourceType,
      sourceId,
      content: scrub.text,
      contentScrubbed: scrub.scrubbed,
      embedding,
      embeddingModel: EMBEDDING_MODEL,
      metadata: {
        ...metadata,
        residualPii: scrub.hasResidualPii,
        residualSignals: scrub.residualSignals,
        redactionCount: scrub.redactions.length,
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn('knowledge_chunks insert failed', {
      sourceType,
      sourceId,
      error: error.message,
    });
  }
}
