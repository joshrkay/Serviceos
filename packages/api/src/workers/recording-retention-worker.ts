/**
 * RV-132 + comms C6 — recording retention sweep.
 *
 * Purges call recordings older than the tenant's
 * `tenant_settings.recording_retention_days` (migration 169; default 365).
 * C6 (spec/RIVET_COMMS_SPEC.md §6): a deletion that misses derived data is
 * not a deletion — the sweep reaches all four data classes:
 *
 *   1. audio — delete the stored object via the StorageProvider (when the
 *      joined files row carries a bucket/key);
 *   2. transcript — null `voice_recordings.transcript` /
 *      `transcript_metadata` and delete the `call_transcript_turns` rows;
 *   3. derived — delete the recording's `call_summaries` row;
 *   4. embeddings — delete the `knowledge_chunks` rows ingested from this
 *      recording (`call_summary` + `call_transcript_window` source types);
 *   then tombstone the voice_recordings row (`purged_at` — the row itself
 *   and every audit event are KEPT for the audit trail) and emit a
 *   `voice_recording.purged` audit event with per-class counts.
 *
 * `legal_hold = true` rows are exempt unconditionally (excluded by the
 * repo's due-query, mirroring the migration's partial index).
 *
 * Pattern: cross-tenant batch drain like dropped-call-worker — per-row
 * failures are logged and left unpurged for the next sweep; the table query
 * is the queue. app.ts drives the cadence behind `runAsLeader`
 * (SWEEP_LOCK.recordingRetention = 590011).
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import type { StorageProvider } from '../files/file-service';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import type { Logger } from '../logging/logger';

/** Default rows purged per sweep — bounds S3 round-trips under a backlog. */
export const RECORDING_RETENTION_SWEEP_BATCH = 50;

/** A purgeable recording (joined with its files row for the object key). */
export interface PurgeableRecording {
  id: string;
  tenantId: string;
  callSid: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  createdAt: Date;
}

/** C6 — per-class row counts removed by `purgeDerived`, for the audit row. */
export interface PurgedDerivedCounts {
  transcriptTurns: number;
  callSummaries: number;
  knowledgeChunks: number;
}

export interface RecordingRetentionRepository {
  /**
   * Cross-tenant: recordings past their tenant's retention horizon that are
   * neither purged nor on legal hold. The horizon is evaluated per-tenant
   * inside the query (`tenant_settings.recording_retention_days`).
   */
  findDue(now: Date, limit: number): Promise<PurgeableRecording[]>;
  /**
   * C6 — delete the recording's transcript (column + turn rows), summary,
   * and embedding chunks in one tenant-scoped transaction. Idempotent:
   * re-running on an already-purged recording deletes nothing.
   */
  purgeDerived(tenantId: string, id: string): Promise<PurgedDerivedCounts>;
  /** Stamp the tombstone. Idempotent (`purged_at IS NULL` guard). */
  markPurged(tenantId: string, id: string, purgedAt: Date): Promise<void>;
}

export class PgRecordingRetentionRepository
  extends PgBaseRepository
  implements RecordingRetentionRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async findDue(now: Date, limit: number): Promise<PurgeableRecording[]> {
    // Cross-tenant drain: withCrossTenantSweep (named rls_cross_tenant role when
    // enforcement is on; same convention as PgDroppedCallRecoveryRepository.findDue);
    // the subsequent tombstone is tenant-scoped.
    return this.withCrossTenantSweep(async (client) => {
      const { rows } = await client.query(
        `SELECT vr.id, vr.tenant_id, vr.call_sid,
                f.s3_bucket, f.s3_key, vr.created_at
           FROM voice_recordings vr
           JOIN tenant_settings ts ON ts.tenant_id = vr.tenant_id
           LEFT JOIN files f ON f.id = vr.file_id
          WHERE vr.purged_at IS NULL
            AND vr.legal_hold = false
            AND vr.created_at <
                $1::timestamptz - make_interval(days => ts.recording_retention_days)
          ORDER BY vr.created_at ASC
          LIMIT $2`,
        [now, limit],
      );
      return rows.map((row) => ({
        id: String(row.id),
        tenantId: String(row.tenant_id),
        callSid: (row.call_sid as string | null) ?? null,
        storageBucket: (row.s3_bucket as string | null) ?? null,
        storageKey: (row.s3_key as string | null) ?? null,
        createdAt: new Date(row.created_at as string),
      }));
    });
  }

  async markPurged(tenantId: string, id: string, purgedAt: Date): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE voice_recordings
            SET purged_at = $3, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND purged_at IS NULL`,
        [tenantId, id, purgedAt],
      );
    });
  }

  async purgeDerived(tenantId: string, id: string): Promise<PurgedDerivedCounts> {
    // One tenant-scoped transaction so a partial purge can't leave the
    // recording looking clean while embeddings survive (I4). knowledge_chunks
    // source ids are the recording id (call_summary) and `<id>:<n>` windows
    // (call_transcript_window) — see transcript-ingestion-worker.ts.
    return this.withTenantTransaction(tenantId, async (client) => {
      const turns = await client.query(
        `DELETE FROM call_transcript_turns
          WHERE tenant_id = $1 AND voice_recording_id = $2`,
        [tenantId, id],
      );
      const summaries = await client.query(
        `DELETE FROM call_summaries
          WHERE tenant_id = $1 AND call_id = $2`,
        [tenantId, id],
      );
      const chunks = await client.query(
        `DELETE FROM knowledge_chunks
          WHERE tenant_id = $1
            AND source_type IN ('call_summary', 'call_transcript_window')
            AND (source_id = $2 OR source_id LIKE $2 || ':%')`,
        [tenantId, id],
      );
      await client.query(
        `UPDATE voice_recordings
            SET transcript = NULL, transcript_metadata = '{}'::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return {
        transcriptTurns: turns.rowCount ?? 0,
        callSummaries: summaries.rowCount ?? 0,
        knowledgeChunks: chunks.rowCount ?? 0,
      };
    });
  }
}

/** In-memory implementation for unit tests. */
export class InMemoryRecordingRetentionRepository
  implements RecordingRetentionRepository
{
  /** C6 — recording ids purgeDerived was called for, in call order. */
  public derivedPurged: Array<{ tenantId: string; id: string }> = [];
  /** C6 — per-recording counts to return from purgeDerived (default zeros). */
  public derivedCounts = new Map<string, PurgedDerivedCounts>();

  constructor(
    public rows: Array<
      PurgeableRecording & {
        legalHold?: boolean;
        purgedAt?: Date | null;
        retentionDays: number;
      }
    > = [],
  ) {}

  async purgeDerived(tenantId: string, id: string): Promise<PurgedDerivedCounts> {
    this.derivedPurged.push({ tenantId, id });
    return (
      this.derivedCounts.get(id) ?? {
        transcriptTurns: 0,
        callSummaries: 0,
        knowledgeChunks: 0,
      }
    );
  }

  async findDue(now: Date, limit: number): Promise<PurgeableRecording[]> {
    return this.rows
      .filter(
        (r) =>
          !r.purgedAt &&
          !r.legalHold &&
          r.createdAt.getTime() <
            now.getTime() - r.retentionDays * 24 * 3600 * 1000,
      )
      .slice(0, limit)
      .map(({ id, tenantId, callSid, storageBucket, storageKey, createdAt }) => ({
        id,
        tenantId,
        callSid,
        storageBucket,
        storageKey,
        createdAt,
      }));
  }

  async markPurged(tenantId: string, id: string, purgedAt: Date): Promise<void> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (row && !row.purgedAt) row.purgedAt = purgedAt;
  }
}

export interface RecordingRetentionWorkerDeps {
  repo: RecordingRetentionRepository;
  storage: StorageProvider;
  auditRepo?: AuditRepository;
  logger: Logger;
  batchSize?: number;
  now?: () => Date;
}

export interface RecordingRetentionSweepResult {
  due: number;
  purged: number;
  failed: number;
}

/**
 * One drain sweep. Per-row failures (S3 delete, tombstone) are logged and
 * the row stays unpurged for the next sweep. Never throws.
 */
export async function runRecordingRetentionSweep(
  deps: RecordingRetentionWorkerDeps,
): Promise<RecordingRetentionSweepResult> {
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? RECORDING_RETENTION_SWEEP_BATCH;

  let due: PurgeableRecording[];
  try {
    due = await deps.repo.findDue(now(), batchSize);
  } catch (err) {
    deps.logger.error('recording-retention sweep: findDue failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { due: 0, purged: 0, failed: 0 };
  }

  let purged = 0;
  let failed = 0;
  for (const row of due) {
    try {
      // 1. Delete the stored bytes (class 1: audio). Rows without a files
      //    join (no object on record) skip straight to the derived purge —
      //    there is nothing to delete but the metadata is still past
      //    retention.
      if (row.storageBucket && row.storageKey) {
        await deps.storage.deleteObject(row.storageBucket, row.storageKey);
      }
      // 2. C6 — classes 2–4: transcript (column + turns), summaries,
      //    embedding chunks. Runs BEFORE the tombstone so a failure here
      //    leaves the row unpurged and retried next sweep, never a
      //    tombstoned recording with surviving derived data.
      const derived = await deps.repo.purgeDerived(row.tenantId, row.id);
      // 3. Tombstone — the row itself + audit trail are KEPT.
      await deps.repo.markPurged(row.tenantId, row.id, now());
      // 4. Audit.
      if (deps.auditRepo) {
        try {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId: row.tenantId,
              actorId: 'recording-retention-worker',
              actorRole: 'system',
              eventType: 'voice_recording.purged',
              entityType: 'voice_recording',
              entityId: row.id,
              metadata: {
                callSid: row.callSid,
                hadStoredObject: Boolean(row.storageBucket && row.storageKey),
                recordedAt: row.createdAt.toISOString(),
                derivedPurged: derived,
              },
            }),
          );
        } catch {
          /* audit is best-effort; the purge already happened */
        }
      }
      purged++;
    } catch (err) {
      failed++;
      deps.logger.warn('recording-retention sweep: row failed', {
        tenantId: row.tenantId,
        voiceRecordingId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('recording-retention sweep completed', {
    due: due.length,
    purged,
    failed,
  });
  return { due: due.length, purged, failed };
}
