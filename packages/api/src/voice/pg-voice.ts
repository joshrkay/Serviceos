import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { TranscriptionStatus, VoiceRecording, VoiceRepository } from './voice-service';

function mapRow(row: Record<string, unknown>): VoiceRecording {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    fileId: row.file_id as string,
    conversationId: row.conversation_id as string | undefined,
    status: row.status as TranscriptionStatus,
    transcript: row.transcript as string | undefined,
    transcriptMetadata: row.transcript_metadata as Record<string, unknown> | undefined,
    durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : undefined,
    errorMessage: row.error_message as string | undefined,
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
        `INSERT INTO voice_recordings (id, tenant_id, file_id, conversation_id, status, transcript, transcript_metadata, duration_seconds, error_message, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          recording.id,
          recording.tenantId,
          recording.fileId,
          recording.conversationId ?? null,
          recording.status,
          recording.transcript ?? null,
          recording.transcriptMetadata ? JSON.stringify(recording.transcriptMetadata) : null,
          recording.durationSeconds ?? null,
          recording.errorMessage ?? null,
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
}
