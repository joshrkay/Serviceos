import { Pool } from 'pg';
import type { VoiceAnswerStatus, VoiceLookupAnswer } from '@ai-service-os/shared';
import { PgBaseRepository } from '../db/pg-base';
import { CallOutcome, TranscriptionStatus, VoiceRecording, VoiceRepository } from './voice-service';

function mapRow(row: Record<string, unknown>): VoiceRecording {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    fileId: (row.file_id as string | null) ?? undefined,
    conversationId: row.conversation_id as string | undefined,
    callSid: (row.call_sid as string | null) ?? undefined,
    // RIVET I13 — recording origin (migration 054); consumed by
    // classifyRecordingProvenance ('inbound_call' → untrusted).
    source: (row.source as string | null) ?? undefined,
    status: row.status as TranscriptionStatus,
    transcript: row.transcript as string | undefined,
    transcriptMetadata: row.transcript_metadata as Record<string, unknown> | undefined,
    durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : undefined,
    errorMessage: row.error_message as string | undefined,
    outcome: (row.outcome as CallOutcome | null) ?? undefined,
    detectedLanguage: (row.detected_language as string | null) ?? undefined,
    purgedAt: row.purged_at ? new Date(row.purged_at as string) : undefined,
    // U3 — routed-outcome back-channel (migration 259). NULL for legacy /
    // telephony rows maps to undefined so the JSON response stays additive.
    answerStatus: (row.answer_status as VoiceAnswerStatus | null) ?? undefined,
    answer: (row.answer as VoiceLookupAnswer | null) ?? undefined,
    // U11 — client idempotency key (migration 260). NULL for legacy /
    // telephony rows maps to undefined so the JSON response stays additive.
    idempotencyKey: (row.idempotency_key as string | null) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgVoiceRepository extends PgBaseRepository implements VoiceRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(recording: VoiceRecording): Promise<VoiceRecording> {
    return this.withTenant(recording.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO voice_recordings (id, tenant_id, file_id, conversation_id, status, transcript, transcript_metadata, duration_seconds, error_message, answer_status, idempotency_key, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          recording.id,
          recording.tenantId,
          recording.fileId ?? null,
          recording.conversationId ?? null,
          recording.status,
          recording.transcript ?? null,
          recording.transcriptMetadata ? JSON.stringify(recording.transcriptMetadata) : null,
          recording.durationSeconds ?? null,
          recording.errorMessage ?? null,
          recording.answerStatus ?? null,
          recording.idempotencyKey ?? null,
          recording.createdBy,
          recording.createdAt,
          recording.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<VoiceRecording | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM voice_recordings WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<VoiceRecording | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM voice_recordings
          WHERE tenant_id = $1 AND idempotency_key = $2
          LIMIT 1`,
        [tenantId, idempotencyKey]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: TranscriptionStatus,
    result?: { transcript?: string; metadata?: Record<string, unknown>; error?: string }
  ): Promise<VoiceRecording | null> {
    return this.withTenant(tenantId, async (client) => {
      const now = new Date();
      const queryResult = await client.query(
        `UPDATE voice_recordings
         SET status = $1,
             transcript = COALESCE($2, transcript),
             transcript_metadata = COALESCE($3::jsonb, transcript_metadata),
             error_message = COALESCE($4, error_message),
             updated_at = $5
         WHERE id = $6 AND tenant_id = $7
         RETURNING *`,
        [
          status,
          result?.transcript ?? null,
          result?.metadata ? JSON.stringify(result.metadata) : null,
          result?.error ?? null,
          now,
          id,
          tenantId,
        ]
      );
      if (queryResult.rows.length === 0) return null;
      return mapRow(queryResult.rows[0]);
    });
  }

  async stampOutcome(
    tenantId: string,
    id: string,
    outcome: CallOutcome,
  ): Promise<VoiceRecording | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE voice_recordings
            SET outcome    = $1,
                updated_at = NOW()
          WHERE id = $2 AND tenant_id = $3
          RETURNING *`,
        [outcome, id, tenantId],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async stampOutcomeByCallSid(
    tenantId: string,
    callSid: string,
    outcome: CallOutcome,
  ): Promise<VoiceRecording | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE voice_recordings
            SET outcome    = $1,
                updated_at = NOW()
          WHERE tenant_id = $2 AND call_sid = $3 AND outcome IS NULL
          RETURNING *`,
        [outcome, tenantId, callSid],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async stampDetectedLanguage(
    tenantId: string,
    id: string,
    language: string,
  ): Promise<VoiceRecording | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE voice_recordings
            SET detected_language = $1,
                updated_at        = NOW()
          WHERE id = $2 AND tenant_id = $3
          RETURNING *`,
        [language, id, tenantId],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async stampProvenance(
    tenantId: string,
    id: string,
    provenance: 'caller' | 'mixed' | 'operator',
  ): Promise<VoiceRecording | null> {
    return this.withTenant(tenantId, async (client) => {
      // RIVET I13 — MERGE into transcript_metadata (jsonb `||`), never a
      // full-column replace: the transcription worker writes a rich metadata
      // object at completion (sanitization_version, raw_transcript_retention,
      // …) and the ingestion worker stamps AFTER it; a replace would clobber
      // that. COALESCE guards pre-default legacy rows where the column is
      // NULL rather than '{}'.
      const result = await client.query(
        `UPDATE voice_recordings
            SET transcript_metadata = COALESCE(transcript_metadata, '{}'::jsonb)
                                      || jsonb_build_object('provenance', $1::text),
                updated_at          = NOW()
          WHERE id = $2 AND tenant_id = $3
          RETURNING *`,
        [provenance, id, tenantId],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async recordAnswer(
    tenantId: string,
    id: string,
    outcome: { answerStatus: VoiceAnswerStatus; answer?: VoiceLookupAnswer },
  ): Promise<VoiceRecording | null> {
    return this.withTenant(tenantId, async (client) => {
      // Write-once: only pending/unset/failed rows accept an outcome
      // ('failed' stays writable so a transcription retry can land a
      // fresh outcome). An at-least-once queue redelivery that lost the
      // race simply matches zero rows and returns null.
      const result = await client.query(
        `UPDATE voice_recordings
            SET answer_status = $1,
                answer        = COALESCE($2::jsonb, answer),
                updated_at    = NOW()
          WHERE id = $3 AND tenant_id = $4
            AND (answer_status IS NULL OR answer_status IN ('pending', 'failed'))
          RETURNING *`,
        [
          outcome.answerStatus,
          outcome.answer ? JSON.stringify(outcome.answer) : null,
          id,
          tenantId,
        ],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }
}
