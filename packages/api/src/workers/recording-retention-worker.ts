/**
 * RV-132 — recording retention sweep.
 *
 * Purges call recordings older than the tenant's
 * `tenant_settings.recording_retention_days` (migration 169; default 365):
 *
 *   1. delete the stored object via the StorageProvider (when the joined
 *      files row carries a bucket/key);
 *   2. tombstone the voice_recordings row (`purged_at`, migration 169 —
 *      the 007 status CHECK has no 'deleted' value, so the dedicated
 *      nullable marker is the non-destructive tombstone; the row, its
 *      transcript, and every audit event are KEPT);
 *   3. emit a `voice_recording.purged` audit event.
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

export interface RecordingRetentionRepository {
  /**
   * Cross-tenant: recordings past their tenant's retention horizon that are
   * neither purged nor on legal hold. The horizon is evaluated per-tenant
   * inside the query (`tenant_settings.recording_retention_days`).
   */
  findDue(now: Date, limit: number): Promise<PurgeableRecording[]>;
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
    // Cross-tenant drain: documented use of withClient (same convention as
    // PgDroppedCallRecoveryRepository.findDue); the subsequent tombstone is
    // tenant-scoped.
    return this.withClient(async (client) => {
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
}

/** In-memory implementation for unit tests. */
export class InMemoryRecordingRetentionRepository
  implements RecordingRetentionRepository
{
  constructor(
    public rows: Array<
      PurgeableRecording & {
        legalHold?: boolean;
        purgedAt?: Date | null;
        retentionDays: number;
      }
    > = [],
  ) {}

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
      // 1. Delete the stored bytes. Rows without a files join (no object on
      //    record) skip straight to the tombstone — there is nothing to
      //    delete but the metadata is still past retention.
      if (row.storageBucket && row.storageKey) {
        await deps.storage.deleteObject(row.storageBucket, row.storageKey);
      }
      // 2. Tombstone — the row + transcript + audit trail are KEPT.
      await deps.repo.markPurged(row.tenantId, row.id, now());
      // 3. Audit.
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
