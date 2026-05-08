import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  AppendVoiceCommandEventInput,
  CompleteTranscriptionAttemptInput,
  CreateIntentRunInput,
  CreateTranscriptVersionInput,
  CreateTranscriptionAttemptInput,
  CreateVoiceFeedbackLabelInput,
  FailTranscriptionAttemptInput,
  TenantVoiceLexiconEntry,
  UpsertTenantVoiceLexiconEntryInput,
  UpdateVoiceCommandStatusInput,
  UpsertVoiceCommandRunInput,
  VoiceAuditRepository,
  VoiceCommandEvent,
  VoiceCommandRun,
  VoiceIntentRun,
  VoiceTranscriptVersion,
  VoiceTranscriptionAttempt,
} from './voice-audit';

function mapAttempt(row: Record<string, unknown>): VoiceTranscriptionAttempt {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    recordingId: row.recording_id as string,
    attemptNo: Number(row.attempt_no),
    provider: row.provider as string,
    model: (row.model as string) ?? undefined,
    status: row.status as VoiceTranscriptionAttempt['status'],
    startedAt: new Date(row.started_at as string),
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
    latencyMs: row.latency_ms != null ? Number(row.latency_ms) : undefined,
    errorCode: (row.error_code as string) ?? undefined,
    errorMessage: (row.error_message as string) ?? undefined,
    rawResponse: (row.raw_response as Record<string, unknown>) ?? undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapTranscriptVersion(row: Record<string, unknown>): VoiceTranscriptVersion {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    recordingId: row.recording_id as string,
    transcriptionAttemptId: (row.transcription_attempt_id as string) ?? undefined,
    versionNo: Number(row.version_no),
    text: row.text as string,
    source: row.source as VoiceTranscriptVersion['source'],
    confidence: row.confidence != null ? Number(row.confidence) : undefined,
    languageCode: (row.language_code as string) ?? undefined,
    wordTimestamps: (row.word_timestamps as unknown[]) ?? [],
    editorUserId: (row.editor_user_id as string) ?? undefined,
    createdAt: new Date(row.created_at as string),
  };
}

function mapIntentRun(row: Record<string, unknown>): VoiceIntentRun {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    recordingId: row.recording_id as string,
    transcriptVersionId: row.transcript_version_id as string,
    aiRunId: (row.ai_run_id as string) ?? undefined,
    intentType: row.intent_type as string,
    intentConfidence: row.intent_confidence != null ? Number(row.intent_confidence) : undefined,
    extractedEntities: (row.extracted_entities as Record<string, unknown>) ?? {},
    rawOutput: (row.raw_output as Record<string, unknown>) ?? {},
    createdAt: new Date(row.created_at as string),
  };
}

function mapCommandRun(row: Record<string, unknown>): VoiceCommandRun {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    recordingId: row.recording_id as string,
    transcriptVersionId: (row.transcript_version_id as string) ?? undefined,
    intentRunId: (row.intent_run_id as string) ?? undefined,
    conversationId: (row.conversation_id as string) ?? undefined,
    commandType: row.command_type as string,
    commandPayload: (row.command_payload as Record<string, unknown>) ?? {},
    targetEntityType: (row.target_entity_type as string) ?? undefined,
    targetEntityId: (row.target_entity_id as string) ?? undefined,
    idempotencyKey: row.idempotency_key as string,
    currentStatus: row.current_status as VoiceCommandRun['currentStatus'],
    failureReason: (row.failure_reason as string) ?? undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapCommandEvent(row: Record<string, unknown>): VoiceCommandEvent {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    commandRunId: row.command_run_id as string,
    eventType: row.event_type as string,
    fromStatus: (row.from_status as string) ?? undefined,
    toStatus: (row.to_status as string) ?? undefined,
    actorId: (row.actor_id as string) ?? undefined,
    actorRole: (row.actor_role as string) ?? undefined,
    correlationId: (row.correlation_id as string) ?? undefined,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    occurredAt: new Date(row.occurred_at as string),
  };
}

function mapLexiconEntry(row: Record<string, unknown>): TenantVoiceLexiconEntry {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    phrase: row.phrase as string,
    canonicalForm: row.canonical_form as string,
    pronunciationHint: (row.pronunciation_hint as string) ?? undefined,
    weight: Number(row.weight),
    isActive: Boolean(row.is_active),
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgVoiceAuditRepository extends PgBaseRepository implements VoiceAuditRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async createTranscriptionAttempt(
    input: CreateTranscriptionAttemptInput
  ): Promise<VoiceTranscriptionAttempt> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO voice_transcription_attempts (
          tenant_id, recording_id, attempt_no, provider, model, status
        ) VALUES ($1, $2, $3, $4, $5, 'processing')
        RETURNING *`,
        [input.tenantId, input.recordingId, input.attemptNo, input.provider, input.model ?? null]
      );
      return mapAttempt(result.rows[0]);
    });
  }

  async completeTranscriptionAttempt(
    input: CompleteTranscriptionAttemptInput
  ): Promise<VoiceTranscriptionAttempt | null> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE voice_transcription_attempts
         SET status = 'completed',
             completed_at = NOW(),
             latency_ms = COALESCE($3, latency_ms),
             raw_response = COALESCE($4::jsonb, raw_response),
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          input.tenantId,
          input.attemptId,
          input.latencyMs ?? null,
          input.rawResponse ? JSON.stringify(input.rawResponse) : null,
        ]
      );
      return result.rows.length > 0 ? mapAttempt(result.rows[0]) : null;
    });
  }

  async failTranscriptionAttempt(
    input: FailTranscriptionAttemptInput
  ): Promise<VoiceTranscriptionAttempt | null> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE voice_transcription_attempts
         SET status = 'failed',
             completed_at = NOW(),
             error_code = $3,
             error_message = $4,
             raw_response = COALESCE($5::jsonb, raw_response),
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          input.tenantId,
          input.attemptId,
          input.errorCode ?? null,
          input.errorMessage,
          input.rawResponse ? JSON.stringify(input.rawResponse) : null,
        ]
      );
      return result.rows.length > 0 ? mapAttempt(result.rows[0]) : null;
    });
  }

  async createTranscriptVersion(input: CreateTranscriptVersionInput): Promise<VoiceTranscriptVersion> {
    return this.withTenant(input.tenantId, async (client) => {
      const nextVersionNo = input.versionNo ?? (
        await client.query(
          `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version
           FROM voice_transcript_versions
           WHERE tenant_id = $1 AND recording_id = $2`,
          [input.tenantId, input.recordingId]
        )
      ).rows[0].next_version;

      const result = await client.query(
        `INSERT INTO voice_transcript_versions (
          tenant_id, recording_id, transcription_attempt_id, version_no, text, source,
          confidence, language_code, word_timestamps, editor_user_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
        RETURNING *`,
        [
          input.tenantId,
          input.recordingId,
          input.transcriptionAttemptId ?? null,
          nextVersionNo,
          input.text,
          input.source,
          input.confidence ?? null,
          input.languageCode ?? null,
          JSON.stringify(input.wordTimestamps ?? []),
          input.editorUserId ?? null,
        ]
      );
      return mapTranscriptVersion(result.rows[0]);
    });
  }

  async createIntentRun(input: CreateIntentRunInput): Promise<VoiceIntentRun> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO voice_intent_runs (
          tenant_id, recording_id, transcript_version_id, ai_run_id,
          intent_type, intent_confidence, extracted_entities, raw_output
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
        RETURNING *`,
        [
          input.tenantId,
          input.recordingId,
          input.transcriptVersionId,
          input.aiRunId ?? null,
          input.intentType,
          input.intentConfidence ?? null,
          JSON.stringify(input.extractedEntities ?? {}),
          JSON.stringify(input.rawOutput ?? {}),
        ]
      );
      return mapIntentRun(result.rows[0]);
    });
  }

  async findCommandRunByIdempotency(
    tenantId: string,
    idempotencyKey: string
  ): Promise<VoiceCommandRun | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM voice_command_runs
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      return result.rows.length > 0 ? mapCommandRun(result.rows[0]) : null;
    });
  }

  async upsertCommandRunForRecording(input: UpsertVoiceCommandRunInput): Promise<VoiceCommandRun> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO voice_command_runs (
          tenant_id, recording_id, transcript_version_id, intent_run_id, conversation_id,
          command_type, command_payload, target_entity_type, target_entity_id, idempotency_key,
          current_status, failure_reason
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
        ON CONFLICT (tenant_id, idempotency_key)
        DO UPDATE SET
          recording_id = EXCLUDED.recording_id,
          transcript_version_id = COALESCE(EXCLUDED.transcript_version_id, voice_command_runs.transcript_version_id),
          intent_run_id = COALESCE(EXCLUDED.intent_run_id, voice_command_runs.intent_run_id),
          conversation_id = COALESCE(EXCLUDED.conversation_id, voice_command_runs.conversation_id),
          command_type = EXCLUDED.command_type,
          command_payload = EXCLUDED.command_payload,
          target_entity_type = COALESCE(EXCLUDED.target_entity_type, voice_command_runs.target_entity_type),
          target_entity_id = COALESCE(EXCLUDED.target_entity_id, voice_command_runs.target_entity_id),
          current_status = EXCLUDED.current_status,
          failure_reason = EXCLUDED.failure_reason,
          updated_at = NOW()
        RETURNING *`,
        [
          input.tenantId,
          input.recordingId,
          input.transcriptVersionId ?? null,
          input.intentRunId ?? null,
          input.conversationId ?? null,
          input.commandType,
          JSON.stringify(input.commandPayload ?? {}),
          input.targetEntityType ?? null,
          input.targetEntityId ?? null,
          input.idempotencyKey,
          input.status,
          input.failureReason ?? null,
        ]
      );
      return mapCommandRun(result.rows[0]);
    });
  }

  async updateCommandRunStatus(input: UpdateVoiceCommandStatusInput): Promise<VoiceCommandRun | null> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE voice_command_runs
         SET current_status = $3,
             failure_reason = COALESCE($4, failure_reason),
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [input.tenantId, input.commandRunId, input.status, input.failureReason ?? null]
      );
      return result.rows.length > 0 ? mapCommandRun(result.rows[0]) : null;
    });
  }

  async appendCommandEvent(input: AppendVoiceCommandEventInput): Promise<VoiceCommandEvent> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO voice_command_events (
          tenant_id, command_run_id, event_type, from_status, to_status, actor_id,
          actor_role, correlation_id, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *`,
        [
          input.tenantId,
          input.commandRunId,
          input.eventType,
          input.fromStatus ?? null,
          input.toStatus ?? null,
          input.actorId ?? null,
          input.actorRole ?? null,
          input.correlationId ?? null,
          JSON.stringify(input.metadata ?? {}),
        ]
      );
      return mapCommandEvent(result.rows[0]);
    });
  }

  async createFeedbackLabel(input: CreateVoiceFeedbackLabelInput) {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO voice_feedback_labels (
          tenant_id, recording_id, transcript_version_id, intent_run_id, command_run_id,
          feedback_type, corrected_transcript, correct_intent, correct_payload, notes, labeled_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
        RETURNING *`,
        [
          input.tenantId,
          input.recordingId,
          input.transcriptVersionId ?? null,
          input.intentRunId ?? null,
          input.commandRunId ?? null,
          input.feedbackType,
          input.correctedTranscript ?? null,
          input.correctIntent ?? null,
          JSON.stringify(input.correctPayload ?? {}),
          input.notes ?? null,
          input.labeledBy,
        ]
      );
      const row = result.rows[0] as Record<string, unknown>;
      return {
        id: row.id as string,
        tenantId: row.tenant_id as string,
        recordingId: row.recording_id as string,
        transcriptVersionId: (row.transcript_version_id as string) ?? undefined,
        intentRunId: (row.intent_run_id as string) ?? undefined,
        commandRunId: (row.command_run_id as string) ?? undefined,
        feedbackType: row.feedback_type as string,
        correctedTranscript: (row.corrected_transcript as string) ?? undefined,
        correctIntent: (row.correct_intent as string) ?? undefined,
        correctPayload: (row.correct_payload as Record<string, unknown>) ?? {},
        notes: (row.notes as string) ?? undefined,
        labeledBy: row.labeled_by as string,
        createdAt: new Date(row.created_at as string),
      };
    });
  }

  async upsertTenantLexiconEntry(input: UpsertTenantVoiceLexiconEntryInput): Promise<TenantVoiceLexiconEntry> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO tenant_voice_lexicon (
          tenant_id, phrase, canonical_form, pronunciation_hint, weight, is_active, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tenant_id, phrase)
        DO UPDATE SET
          canonical_form = EXCLUDED.canonical_form,
          pronunciation_hint = EXCLUDED.pronunciation_hint,
          weight = EXCLUDED.weight,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
        RETURNING *`,
        [
          input.tenantId,
          input.phrase,
          input.canonicalForm,
          input.pronunciationHint ?? null,
          input.weight ?? 1,
          input.isActive ?? true,
          input.createdBy,
        ]
      );
      return mapLexiconEntry(result.rows[0]);
    });
  }

  async listActiveTenantLexicon(tenantId: string): Promise<TenantVoiceLexiconEntry[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tenant_voice_lexicon
         WHERE tenant_id = $1 AND is_active = true
         ORDER BY weight DESC, phrase ASC`,
        [tenantId]
      );
      return result.rows.map((row) => mapLexiconEntry(row as Record<string, unknown>));
    });
  }
}
