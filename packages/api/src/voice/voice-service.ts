import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { VoiceAnswerStatus, VoiceLookupAnswer } from '@ai-service-os/shared';
import { applyTenantContext } from '../db/rls-runtime-role';

export type TranscriptionStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Terminal-state outcome stamped at FSM hangup so analytics can correlate
 * a recording with what actually happened on the call. Distinct from
 * `TranscriptionStatus` (which tracks the audio-file lifecycle):
 *
 *   - completed             — call resolved with at least one queued proposal
 *   - escalated_to_human    — escalate-to-human skill emitted a transfer
 *   - callback_required     — no dispatcher available; callback proposal queued
 *   - dropped               — caller hung up before any intent was captured
 *   - no_intent             — caller stayed on but classifier never crossed TAU_INT
 *   - failed                — system_failure event landed the FSM in escalating
 *
 * Stamped by both adapter finalize hooks (B2): voice_sessions.outcome
 * always, voice_recordings.outcome when a recording exists. Derivation
 * lives in `ai/agents/customer-calling/outcome-mapper.ts`.
 */
export type CallOutcome =
  | 'completed'
  | 'escalated_to_human'
  | 'callback_required'
  | 'dropped'
  | 'no_intent'
  | 'failed';

export interface VoiceRecording {
  id: string;
  tenantId: string;
  /** File record ID — present for in-app voice-note uploads, absent for Twilio call recordings. */
  fileId?: string;
  conversationId?: string;
  /** Twilio CallSid — set for inbound call recordings, absent for uploads. */
  callSid?: string;
  /**
   * Origin of the recording (`voice_recordings.source`, migration 054):
   * 'inbound_call' | 'inapp_voice' | 'batch_upload'. Load-bearing for
   * RIVET I13 — `classifyRecordingProvenance` treats 'inbound_call' as
   * untrusted unconditionally (caller audio is on the recording).
   */
  source?: string;
  status: TranscriptionStatus;
  transcript?: string;
  /**
   * Provider + pipeline metadata for the transcript (JSONB). Carries the
   * RIVET I13 marker `provenance: 'caller' | 'mixed' | 'operator'` (stamped
   * by the transcript-ingestion worker via `stampProvenance`). Check it via
   * `classifyRecordingProvenance` (ai/content-provenance.ts) — which fails
   * closed — before quoting `transcript` into any operator-facing prompt.
   */
  transcriptMetadata?: Record<string, unknown>;
  durationSeconds?: number;
  errorMessage?: string;
  outcome?: CallOutcome;
  /**
   * Phase 4c: BCP-47 short code (or 'und') of the language detected on
   * the joined transcript at end-of-session. NULL until stamped — older
   * recordings keep NULL forever (no backfill in 4c). Dashboards group
   * NULL/'und' as the "unknown" bucket.
   */
  detectedLanguage?: string;
  /**
   * RV-132 — retention-purge tombstone. Set by the recording-retention
   * worker after the stored audio object is deleted; the row (and its
   * files FK target) is KEPT. Any audio download path must check this and
   * answer 410 instead of handing out a URL to a deleted S3 object.
   */
  purgedAt?: Date;
  /**
   * U3 (E-lane answers) — routed outcome of the memo. Distinct from
   * `status` (the audio-file lifecycle): transcription flips
   * `status='completed'` BEFORE the voice-action-router job even
   * enqueues, so clients poll `status` first and then this field in a
   * bounded second phase. `pending` at creation on the in-app memo
   * path; stamped exactly once by the router (recordAnswer's
   * pending-guard makes redeliveries no-ops). NULL for rows that
   * predate the column and for the telephony path (which has a live
   * voice back-channel and never uses this worker).
   */
  answerStatus?: VoiceAnswerStatus;
  /** U3 — structured lookup answer; present only when answerStatus='answered'. */
  answer?: VoiceLookupAnswer;
  /**
   * U11 (offline prerequisite) — client-supplied idempotency key for the
   * in-app voice-note create path. UNIQUE PER TENANT (partial unique index,
   * WHERE idempotency_key IS NOT NULL). A replayed create (same tenant+key)
   * resolves to the ORIGINAL recording instead of minting a duplicate.
   * NULL for legacy rows and every server-minted path (telephony) that never
   * carries a client key.
   */
  idempotencyKey?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IngestVoiceInput {
  tenantId: string;
  fileId: string;
  conversationId?: string;
  createdBy: string;
  /** U11 — optional client idempotency key (unique per tenant when present). */
  idempotencyKey?: string;
}

export interface VoiceRepository {
  create(recording: VoiceRecording): Promise<VoiceRecording>;
  findById(tenantId: string, id: string): Promise<VoiceRecording | null>;
  /**
   * U11 — resolve an existing recording by its client idempotency key,
   * scoped to the tenant. Backs the create-path replay guard: a repeat
   * POST /api/voice/recordings with the same key returns the ORIGINAL
   * recording instead of minting a duplicate. Returns null when no row in
   * the tenant carries that key.
   */
  findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<VoiceRecording | null>;
  updateStatus(
    tenantId: string,
    id: string,
    status: TranscriptionStatus,
    result?: { transcript?: string; metadata?: Record<string, unknown>; error?: string }
  ): Promise<VoiceRecording | null>;
  /**
   * Stamp the terminal call outcome. Optional on the interface so older
   * repos still satisfy the type — callers should treat a `null` return
   * as "not supported." Phase 2 of the RAG plan: the column exists on
   * voice_recordings but stamping is wired in Phase 4a.
   */
  stampOutcome?(
    tenantId: string,
    id: string,
    outcome: CallOutcome,
  ): Promise<VoiceRecording | null>;
  /**
   * Convenience variant that looks up by callSid instead of row UUID.
   * Optional; falls back to no-op when absent.
   */
  stampOutcomeByCallSid?(
    tenantId: string,
    callSid: string,
    outcome: CallOutcome,
  ): Promise<VoiceRecording | null>;
  /**
   * Phase 4c: stamp the detected language (BCP-47 short code, e.g. 'en'
   * or 'es'). Called once per call from the FSM's end-of-session hook
   * after the joined transcript runs through `LanguageDetector`.
   * Optional for repo-interface backwards compatibility — pre-4c repos
   * still satisfy the type and the stamp is a soft no-op.
   */
  stampDetectedLanguage?(
    tenantId: string,
    id: string,
    language: string,
  ): Promise<VoiceRecording | null>;
  /**
   * U3 — persist the routed outcome (and, for lookups, the structured
   * answer) on the recording. Write-once semantics: only rows whose
   * answer_status is NULL / 'pending' / 'failed' accept the write
   * ('failed' stays writable so a transcription retry can land a fresh
   * outcome), so an at-least-once queue redelivery can never overwrite
   * a terminal outcome. Returns null when the row is missing, belongs
   * to another tenant, or already carries a terminal outcome. Optional
   * for repo-interface backwards compatibility (mirrors stampOutcome).
   */
  recordAnswer?(
    tenantId: string,
    id: string,
    outcome: { answerStatus: VoiceAnswerStatus; answer?: VoiceLookupAnswer },
  ): Promise<VoiceRecording | null>;
  /**
   * RIVET I13 — stamp the speaker provenance of the recording's transcript
   * into `transcript_metadata.provenance` ('caller' | 'mixed' | 'operator'),
   * computed by the transcript-ingestion worker from the real per-turn
   * speaker distribution. MERGE semantics, never replace: the transcription
   * worker writes a rich transcriptMetadata object at completion and
   * ingestion runs after it, so a full-replace would clobber it. Readers
   * classify via `classifyRecordingProvenance` (ai/content-provenance.ts),
   * which FAILS CLOSED — an unstamped row is untrusted. Optional for
   * repo-interface backwards compatibility (mirrors stampOutcome).
   */
  stampProvenance?(
    tenantId: string,
    id: string,
    provenance: 'caller' | 'mixed' | 'operator',
  ): Promise<VoiceRecording | null>;
}

export interface TranscriptionProvider {
  transcribe(audioUrl: string): Promise<{ transcript: string; metadata: Record<string, unknown> }>;
}

const AUDIO_CONTENT_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm'];

export function validateVoiceIngest(input: IngestVoiceInput, fileContentType?: string): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.fileId) errors.push('fileId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (fileContentType && !AUDIO_CONTENT_TYPES.includes(fileContentType)) {
    errors.push(`Invalid audio content type: ${fileContentType}`);
  }
  return errors;
}

export function createVoiceRecording(input: IngestVoiceInput): VoiceRecording {
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    fileId: input.fileId ?? undefined,
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
    status: 'pending',
    // U3 — the in-app memo path starts its routed-outcome lifecycle at
    // 'pending' so clients can distinguish "router hasn't landed yet"
    // from "nothing will ever land" (NULL: telephony / legacy rows).
    answerStatus: 'pending',
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export interface TranscribeAudioOptions {
  /** ISO 639-1 language code hint (e.g. 'en', 'es', 'fr'). Improves accuracy. */
  language?: string;
}

/**
 * Synchronous transcription function type.
 * Accepts raw audio buffer + content type, returns transcript immediately.
 */
export interface TranscribeAudioFn {
  (audioBuffer: Buffer, contentType: string, options?: TranscribeAudioOptions): Promise<{ transcript: string; metadata: Record<string, unknown> }>;
}

/**
 * Create a transcribeAudio function backed by OpenAI Whisper API.
 * Falls back to a dev-mode stub when no API key is provided.
 */
export function createTranscribeAudioFn(apiKey?: string): TranscribeAudioFn {
  if (apiKey) {
    return async (audioBuffer: Buffer, contentType: string, options?: TranscribeAudioOptions) => {
      const ext = contentType.includes('webm') ? 'webm'
        : contentType.includes('wav') ? 'wav'
        : contentType.includes('ogg') ? 'ogg'
        : contentType.includes('mpeg') ? 'mp3'
        : 'webm';
      const fd = new FormData();
      const audioBytes = new Uint8Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength);
      fd.append('file', new Blob([audioBytes], { type: contentType }), 'audio.' + ext);
      fd.append('model', 'whisper-1');
      if (options?.language) {
        fd.append('language', options.language);
      }
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: fd,
        // Bounded like the WhisperTranscriptionProvider in
        // voice/transcription-providers.ts (60s) — fetch has no default
        // timeout and a stalled STT upstream would hang the voice pipeline.
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Whisper API error ${res.status}: ${errBody}`);
      }
      const data = (await res.json()) as { text?: string };
      return {
        transcript: data.text || '',
        metadata: {
          provider: 'openai-whisper',
          processedAt: new Date().toISOString(),
          language: options?.language ?? 'auto',
        },
      };
    };
  }

  return async (_audioBuffer: Buffer, _contentType: string, _options?: TranscribeAudioOptions) => ({
    transcript: '[Dev mode] Voice transcription placeholder — configure AI_PROVIDER_API_KEY for real STT.',
    metadata: { provider: 'dev-fallback', processedAt: new Date().toISOString() },
  });
}

export class InMemoryVoiceRepository implements VoiceRepository {
  private recordings: Map<string, VoiceRecording> = new Map();

  async create(recording: VoiceRecording): Promise<VoiceRecording> {
    this.recordings.set(recording.id, { ...recording });
    return recording;
  }

  async findById(tenantId: string, id: string): Promise<VoiceRecording | null> {
    const rec = this.recordings.get(id);
    if (!rec || rec.tenantId !== tenantId) return null;
    return { ...rec };
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<VoiceRecording | null> {
    for (const [, rec] of this.recordings) {
      if (rec.tenantId === tenantId && rec.idempotencyKey === idempotencyKey) {
        return { ...rec };
      }
    }
    return null;
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: TranscriptionStatus,
    result?: { transcript?: string; metadata?: Record<string, unknown>; error?: string }
  ): Promise<VoiceRecording | null> {
    const rec = this.recordings.get(id);
    if (!rec || rec.tenantId !== tenantId) return null;

    rec.status = status;
    rec.updatedAt = new Date();
    if (result?.transcript) rec.transcript = result.transcript;
    if (result?.metadata) rec.transcriptMetadata = result.metadata;
    if (result?.error) rec.errorMessage = result.error;

    this.recordings.set(id, rec);
    return { ...rec };
  }

  async stampOutcome(
    tenantId: string,
    id: string,
    outcome: CallOutcome,
  ): Promise<VoiceRecording | null> {
    const rec = this.recordings.get(id);
    if (!rec || rec.tenantId !== tenantId) return null;
    rec.outcome = outcome;
    rec.updatedAt = new Date();
    this.recordings.set(id, rec);
    return { ...rec };
  }

  async stampDetectedLanguage(
    tenantId: string,
    id: string,
    language: string,
  ): Promise<VoiceRecording | null> {
    const rec = this.recordings.get(id);
    if (!rec || rec.tenantId !== tenantId) return null;
    rec.detectedLanguage = language;
    rec.updatedAt = new Date();
    this.recordings.set(id, rec);
    return { ...rec };
  }

  async stampProvenance(
    tenantId: string,
    id: string,
    provenance: 'caller' | 'mixed' | 'operator',
  ): Promise<VoiceRecording | null> {
    const rec = this.recordings.get(id);
    if (!rec || rec.tenantId !== tenantId) return null;
    // Merge — never replace — mirroring the pg `||` semantics: the
    // transcription worker's rich metadata must survive the stamp.
    rec.transcriptMetadata = { ...(rec.transcriptMetadata ?? {}), provenance };
    rec.updatedAt = new Date();
    this.recordings.set(id, rec);
    return { ...rec };
  }

  async stampOutcomeByCallSid(
    tenantId: string,
    callSid: string,
    outcome: CallOutcome,
  ): Promise<VoiceRecording | null> {
    for (const [, rec] of this.recordings) {
      // Only stamp when outcome is currently unset — replay-safe semantics.
      if (rec.tenantId === tenantId && rec.callSid === callSid && !rec.outcome) {
        rec.outcome = outcome;
        rec.updatedAt = new Date();
        this.recordings.set(rec.id, rec);
        return { ...rec };
      }
    }
    return null;
  }

  async recordAnswer(
    tenantId: string,
    id: string,
    outcome: { answerStatus: VoiceAnswerStatus; answer?: VoiceLookupAnswer },
  ): Promise<VoiceRecording | null> {
    const rec = this.recordings.get(id);
    if (!rec || rec.tenantId !== tenantId) return null;
    // Write-once guard (mirrors PgVoiceRepository): only pending/unset/failed
    // rows accept an outcome, so a redelivery can't clobber a terminal state.
    if (rec.answerStatus && rec.answerStatus !== 'pending' && rec.answerStatus !== 'failed') {
      return null;
    }
    rec.answerStatus = outcome.answerStatus;
    if (outcome.answer) rec.answer = outcome.answer;
    rec.updatedAt = new Date();
    this.recordings.set(id, rec);
    return { ...rec };
  }
}

// ─── recordInboundCall (P8-014) ──────────────────────────────────────────────

export interface RecordInboundCallInput {
  tenantId: string;
  callSid: string;
  recordingUrl: string;
  durationSeconds: number;
  storageBucket: string;
  storageKey: string;
  sizeBytes: number;
  contentType?: string;
  /** Actor recorded as files.uploaded_by / voice_recordings.created_by. */
  createdBy?: string;
}

export interface RecordInboundCallResult {
  /** ID of the voice_recordings row (existing or newly created). */
  voiceRecordingId: string;
  /** True when a new row was inserted; false when an existing row matched. */
  inserted: boolean;
}

/**
 * Persist a `voice_recordings` row for a finalized Twilio inbound call
 * recording. Idempotent on `(tenant_id, call_sid)` via SELECT-then-INSERT
 * inside a transaction — a second webhook delivery for the same
 * RecordingSid is a no-op that returns the existing row's id.
 *
 * The function inserts a `files` row as the FK target before the
 * voice_recordings row, mirroring the `(file_id NOT NULL REFERENCES files)`
 * shape from migration 007. Both rows are written under the same
 * tenant-scoped GUC (`app.current_tenant_id`) so RLS policies apply.
 *
 * Note: this helper is the canonical "call recorded" insertion path for
 * the telephony pipeline. Other callers (in-app, batch upload) use
 * VoiceRepository.create() with `source` defaulting to 'inapp_voice' or
 * 'batch_upload' instead.
 */
export async function recordInboundCall(
  pool: Pool,
  input: RecordInboundCallInput,
): Promise<RecordInboundCallResult> {
  const client = await pool.connect();
  try {
    // Wrap the SELECT-then-INSERT in a transaction so concurrent
    // Twilio retries can't both pass the existence check and produce
    // duplicate (files, voice_recordings) rows. The DB-level uniqueness
    // is partial / advisory today; the transaction is what enforces
    // atomicity here.
    await client.query('BEGIN');
    await applyTenantContext(client, input.tenantId, { transactional: true });
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM voice_recordings
       WHERE tenant_id = $1 AND call_sid = $2 AND source = 'inbound_call'
       LIMIT 1
       FOR UPDATE`,
      [input.tenantId, input.callSid],
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return { voiceRecordingId: existing.rows[0].id, inserted: false };
    }

    const fileId = randomUUID();
    const now = new Date();
    const filename = `${input.callSid}.mp3`;
    const contentType = input.contentType ?? 'audio/mpeg';
    const createdBy = input.createdBy ?? 'twilio-recording-webhook';

    await client.query(
      `INSERT INTO files
         (id, tenant_id, filename, content_type, size_bytes, s3_bucket, s3_key,
          entity_type, entity_id, uploaded_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        fileId,
        input.tenantId,
        filename,
        contentType,
        input.sizeBytes,
        input.storageBucket,
        input.storageKey,
        'voice_recording',
        input.callSid,
        createdBy,
        now,
        now,
      ],
    );

    const voiceRecordingId = randomUUID();
    await client.query(
      `INSERT INTO voice_recordings
         (id, tenant_id, file_id, status, duration_seconds, created_by,
          created_at, updated_at, call_sid, source, recording_url)
       VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7, $8, 'inbound_call', $9)`,
      [
        voiceRecordingId,
        input.tenantId,
        fileId,
        input.durationSeconds,
        createdBy,
        now,
        now,
        input.callSid,
        input.recordingUrl,
      ],
    );

    await client.query('COMMIT');
    return { voiceRecordingId, inserted: true };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may already be in error state */ }
    throw err;
  } finally {
    // GUC leak fix: plain `SET app.current_tenant_id` persists past
    // COMMIT/ROLLBACK on the underlying connection. Clear it before
    // release so the next pool checkout doesn't inherit this tenant's
    // context.
    try { await client.query('RESET app.current_tenant_id'); } catch { /* ignore */ }
    client.release();
  }
}
