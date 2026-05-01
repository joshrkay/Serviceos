import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { setTenantContext } from '../db/schema';

export type TranscriptionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface VoiceRecording {
  id: string;
  tenantId: string;
  fileId: string;
  conversationId?: string;
  status: TranscriptionStatus;
  transcript?: string;
  transcriptMetadata?: Record<string, unknown>;
  durationSeconds?: number;
  errorMessage?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IngestVoiceInput {
  tenantId: string;
  fileId: string;
  conversationId?: string;
  createdBy: string;
}

export interface VoiceRepository {
  create(recording: VoiceRecording): Promise<VoiceRecording>;
  findById(tenantId: string, id: string): Promise<VoiceRecording | null>;
  updateStatus(
    tenantId: string,
    id: string,
    status: TranscriptionStatus,
    result?: { transcript?: string; metadata?: Record<string, unknown>; error?: string }
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
    fileId: input.fileId,
    conversationId: input.conversationId,
    status: 'pending',
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
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
    await client.query(setTenantContext(input.tenantId));
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
    await client.query('ROLLBACK').catch(() => {
      /* swallow — connection may already be in error state */
    });
    throw err;
  } finally {
    client.release();
  }
}
