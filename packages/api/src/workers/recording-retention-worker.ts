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
 * #1202 — unattached transcript turns. `persistTurn` (voice-session-store)
 * writes mid-call turns with `voice_recording_id` NULL; only the recording
 * webhook's `attachRecording` links them to a recording. A call that never
 * gets one (Media Streams, missing storage/Twilio credentials, a failed
 * upload) would otherwise keep its transcript forever, so the sweep also
 * deletes unattached turns whose own `created_at` is past the tenant's
 * horizon, and audits each call as `voice_session.transcript_purged`.
 *   - Legal hold: `voice_recording_id IS NULL` does NOT mean the call has no
 *     recording. The voicemail leg (voicemail-status-route → recordInboundCall)
 *     never attaches turns, and recording-transcript-hook swallows a failed
 *     attach that no retry repeats, so unattached turns can sit beside a real
 *     `voice_recordings` row for the same CallSid. A same-tenant recording
 *     with that CallSid on `legal_hold` therefore exempts the call's
 *     unattached turns (checked in both the tenant selection and the DELETE).
 *     Attached turns are never touched by this path; they leave only with
 *     their recording (`purgeDerived`), which honours the hold itself.
 *   - Ingestion window: the recording webhook attaches within minutes and the
 *     horizon is at least one day (`recording_retention_days > 0`), so a row
 *     still waiting for its recording is never past the horizon. A row still
 *     unattached past the horizon is treated as a call that never got a
 *     recording. A concurrent attach is safe: the DELETE re-checks
 *     `voice_recording_id IS NULL` on the row version it locks, so a row
 *     attached first is left for the recording path.
 *   - Same conventions as the recording drain: cross-tenant selection
 *     (`withCrossTenantSweep`), tenant-scoped bounded deletes, and one
 *     tenant's failure is logged and retried next sweep without stopping the
 *     rest.
 *
 * #1208 — `voice_sessions.transcript`. The FSM hangup (`markEnded`) copies
 * the whole call transcript onto the session row (migration 092). The sweep
 * nulls it once the session's `started_at` is past the tenant's horizon,
 * with or without a recording, and audits each session as
 * `voice_session.transcript_purged` (reason `session_transcript_past_retention`).
 * The row and its non-content columns (outcome, cost, call_sid, customer)
 * are kept for analytics and the interactions list, whose readers already
 * treat a NULL transcript as "no transcript recorded". Legal hold, tenant
 * selection, bounded per-tenant batches and per-tenant failure isolation
 * follow the #1202 unattached-turn phase exactly.
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

/** #1202 — tenants with expired unattached transcript turns served per sweep. */
export const UNATTACHED_TURN_SWEEP_TENANT_LIMIT = 100;

/** #1202 — unattached transcript turns deleted per tenant per sweep. */
export const UNATTACHED_TURN_SWEEP_BATCH = 1000;

/** #1208 — tenants with expired voice_sessions transcripts served per sweep. */
export const SESSION_TRANSCRIPT_SWEEP_TENANT_LIMIT = 100;

/** #1208 — voice_sessions transcripts cleared per tenant per sweep. */
export const SESSION_TRANSCRIPT_SWEEP_BATCH = 500;

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

/** #1202 — one call's unattached transcript turns removed by `purgeUnattachedTurns`. */
export interface PurgedUnattachedCall {
  /** Always set by `persistTurn`; null only for a row written outside it. */
  callSid: string | null;
  transcriptTurns: number;
  oldestTurnAt: Date;
}

/** #1208 — one voice_sessions row whose transcript `purgeSessionTranscripts` cleared. */
export interface PurgedSessionTranscript {
  sessionId: string;
  callSid: string | null;
  startedAt: Date;
  /** Number of transcript lines the column held. */
  transcriptLines: number;
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
  /**
   * #1202 — cross-tenant: tenants holding `call_transcript_turns` rows with
   * no recording whose `created_at` is past the tenant's horizon and whose
   * CallSid has no same-tenant recording on legal hold, oldest backlog first.
   */
  findTenantsWithDueUnattachedTurns(now: Date, limit: number): Promise<string[]>;
  /**
   * #1202 — delete up to `limit` of the tenant's unattached turns past its
   * horizon (oldest first) in one tenant-scoped transaction, grouped per call
   * for the audit row. Never touches a turn that has a recording, nor one
   * whose CallSid has a same-tenant recording on legal hold.
   */
  purgeUnattachedTurns(
    tenantId: string,
    now: Date,
    limit: number,
  ): Promise<PurgedUnattachedCall[]>;
  /**
   * #1208 — cross-tenant: tenants holding a `voice_sessions.transcript` whose
   * session started before the tenant's horizon and whose CallSid has no
   * same-tenant recording on legal hold, oldest backlog first.
   */
  findTenantsWithDueSessionTranscripts(now: Date, limit: number): Promise<string[]>;
  /**
   * #1208 — null up to `limit` of the tenant's session transcripts past its
   * horizon (oldest first) in one tenant-scoped transaction. Never touches a
   * session whose CallSid has a same-tenant recording on legal hold.
   */
  purgeSessionTranscripts(
    tenantId: string,
    now: Date,
    limit: number,
  ): Promise<PurgedSessionTranscript[]>;
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

  async findTenantsWithDueUnattachedTurns(now: Date, limit: number): Promise<string[]> {
    // Cross-tenant selection, same role convention as findDue. Driven from
    // tenant_settings (one row per tenant) with a LATERAL probe, so each
    // tenant is an index range scan on idx_call_transcript_turns_tenant
    // (tenant_id, created_at) below its own horizon rather than a full scan
    // of the turns table every hour. Held calls are excluded here too, so a
    // tenant whose only old rows are on hold never takes a tenant slot.
    return this.withCrossTenantSweep(async (client) => {
      const { rows } = await client.query(
        `SELECT ts.tenant_id
           FROM tenant_settings ts
           CROSS JOIN LATERAL (
             SELECT ctt.created_at
               FROM call_transcript_turns ctt
              WHERE ctt.tenant_id = ts.tenant_id
                AND ctt.voice_recording_id IS NULL
                AND ctt.created_at <
                    $1::timestamptz - make_interval(days => ts.recording_retention_days)
                AND NOT EXISTS (
                  SELECT 1 FROM voice_recordings vr
                   WHERE vr.tenant_id = ctt.tenant_id
                     AND vr.call_sid = ctt.call_sid
                     AND vr.legal_hold
                )
              ORDER BY ctt.created_at ASC
              LIMIT 1
           ) oldest
          ORDER BY oldest.created_at ASC
          LIMIT $2`,
        [now, limit],
      );
      return rows.map((row) => String(row.tenant_id));
    });
  }

  async purgeUnattachedTurns(
    tenantId: string,
    now: Date,
    limit: number,
  ): Promise<PurgedUnattachedCall[]> {
    // Tenant-scoped. The horizon is re-read from tenant_settings inside the
    // DELETE, so a retention change between selection and deletion is
    // honoured. The outer `voice_recording_id IS NULL` is re-evaluated against
    // the row version the DELETE locks, so a turn attachRecording linked
    // concurrently is skipped rather than deleted from under its recording.
    // Legal hold on a same-tenant recording for the call's CallSid exempts
    // the row: excluded inside the batch (so held rows never consume the
    // LIMIT and stall the drain) and re-checked on the deleted row itself.
    return this.withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(
        `DELETE FROM call_transcript_turns t
          USING (
            SELECT ctt.id
              FROM call_transcript_turns ctt
              JOIN tenant_settings ts ON ts.tenant_id = ctt.tenant_id
             WHERE ctt.tenant_id = $1
               AND ctt.voice_recording_id IS NULL
               AND ctt.created_at <
                   $2::timestamptz - make_interval(days => ts.recording_retention_days)
               AND NOT EXISTS (
                 SELECT 1 FROM voice_recordings vr
                  WHERE vr.tenant_id = ctt.tenant_id
                    AND vr.call_sid = ctt.call_sid
                    AND vr.legal_hold
               )
             ORDER BY ctt.created_at ASC
             LIMIT $3
          ) due
          WHERE t.id = due.id
            AND t.tenant_id = $1
            AND t.voice_recording_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM voice_recordings vr
               WHERE vr.tenant_id = t.tenant_id
                 AND vr.call_sid = t.call_sid
                 AND vr.legal_hold
            )
          RETURNING t.call_sid, t.created_at`,
        [tenantId, now, limit],
      );
      return groupPurgedTurnsByCall(
        rows.map((row) => ({
          callSid: (row.call_sid as string | null) ?? null,
          createdAt: new Date(row.created_at as string),
        })),
      );
    });
  }

  async findTenantsWithDueSessionTranscripts(now: Date, limit: number): Promise<string[]> {
    // Same shape as findTenantsWithDueUnattachedTurns: tenant_settings driven,
    // LATERAL probe on voice_sessions_tenant_started (tenant_id, started_at).
    return this.withCrossTenantSweep(async (client) => {
      const { rows } = await client.query(
        `SELECT ts.tenant_id
           FROM tenant_settings ts
           CROSS JOIN LATERAL (
             SELECT vs.started_at
               FROM voice_sessions vs
              WHERE vs.tenant_id = ts.tenant_id
                AND vs.transcript IS NOT NULL
                AND vs.started_at <
                    $1::timestamptz - make_interval(days => ts.recording_retention_days)
                AND NOT EXISTS (
                  SELECT 1 FROM voice_recordings vr
                   WHERE vr.tenant_id = vs.tenant_id
                     AND vr.call_sid = vs.call_sid
                     AND vr.legal_hold
                )
              ORDER BY vs.started_at ASC
              LIMIT 1
           ) oldest
          ORDER BY oldest.started_at ASC
          LIMIT $2`,
        [now, limit],
      );
      return rows.map((row) => String(row.tenant_id));
    });
  }

  async purgeSessionTranscripts(
    tenantId: string,
    now: Date,
    limit: number,
  ): Promise<PurgedSessionTranscript[]> {
    // Tenant-scoped; the horizon is re-read inside the UPDATE and the hold is
    // re-checked on the locked row (same conventions as purgeUnattachedTurns).
    // The pre-update line count is read from the `due` subquery snapshot.
    return this.withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE voice_sessions s
            SET transcript = NULL, updated_at = now()
           FROM (
             SELECT vs.id,
                    CASE WHEN jsonb_typeof(vs.transcript) = 'array'
                         THEN jsonb_array_length(vs.transcript) ELSE 1 END AS lines
               FROM voice_sessions vs
               JOIN tenant_settings ts ON ts.tenant_id = vs.tenant_id
              WHERE vs.tenant_id = $1
                AND vs.transcript IS NOT NULL
                AND vs.started_at <
                    $2::timestamptz - make_interval(days => ts.recording_retention_days)
                AND NOT EXISTS (
                  SELECT 1 FROM voice_recordings vr
                   WHERE vr.tenant_id = vs.tenant_id
                     AND vr.call_sid = vs.call_sid
                     AND vr.legal_hold
                )
              ORDER BY vs.started_at ASC
              LIMIT $3
           ) due
          WHERE s.id = due.id
            AND s.tenant_id = $1
            AND s.transcript IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM voice_recordings vr
               WHERE vr.tenant_id = s.tenant_id
                 AND vr.call_sid = s.call_sid
                 AND vr.legal_hold
            )
          RETURNING s.id, s.call_sid, s.started_at, due.lines`,
        [tenantId, now, limit],
      );
      return rows.map((row) => ({
        sessionId: String(row.id),
        callSid: (row.call_sid as string | null) ?? null,
        startedAt: new Date(row.started_at as string),
        transcriptLines: Number(row.lines),
      }));
    });
  }
}

/** #1202 — fold deleted turn rows into one audit entry per call. */
function groupPurgedTurnsByCall(
  turns: ReadonlyArray<{ callSid: string | null; createdAt: Date }>,
): PurgedUnattachedCall[] {
  const byCall = new Map<string | null, PurgedUnattachedCall>();
  for (const turn of turns) {
    const call = byCall.get(turn.callSid);
    if (!call) {
      byCall.set(turn.callSid, {
        callSid: turn.callSid,
        transcriptTurns: 1,
        oldestTurnAt: turn.createdAt,
      });
    } else {
      call.transcriptTurns += 1;
      if (turn.createdAt < call.oldestTurnAt) call.oldestTurnAt = turn.createdAt;
    }
  }
  return [...byCall.values()];
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
    /** #1202 — call_transcript_turns rows with no recording. */
    public unattachedTurns: Array<{
      tenantId: string;
      callSid: string | null;
      createdAt: Date;
      retentionDays: number;
    }> = [],
    /** #1208 — voice_sessions rows that carry a transcript. */
    public sessionTranscripts: Array<{
      id: string;
      tenantId: string;
      callSid: string | null;
      startedAt: Date;
      transcript: string[] | null;
      retentionDays: number;
    }> = [],
  ) {}

  private dueSessionTranscripts(now: Date) {
    return this.sessionTranscripts
      .filter(
        (s) =>
          s.transcript !== null &&
          s.startedAt.getTime() < now.getTime() - s.retentionDays * 24 * 3600 * 1000 &&
          !this.rows.some(
            (r) => r.tenantId === s.tenantId && r.callSid === s.callSid && r.legalHold,
          ),
      )
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  async findTenantsWithDueSessionTranscripts(now: Date, limit: number): Promise<string[]> {
    return [...new Set(this.dueSessionTranscripts(now).map((s) => s.tenantId))].slice(0, limit);
  }

  async purgeSessionTranscripts(
    tenantId: string,
    now: Date,
    limit: number,
  ): Promise<PurgedSessionTranscript[]> {
    const doomed = this.dueSessionTranscripts(now)
      .filter((s) => s.tenantId === tenantId)
      .slice(0, limit);
    return doomed.map((s) => {
      const transcriptLines = s.transcript?.length ?? 0;
      s.transcript = null;
      return { sessionId: s.id, callSid: s.callSid, startedAt: s.startedAt, transcriptLines };
    });
  }

  private dueUnattachedTurns(now: Date) {
    return this.unattachedTurns
      .filter(
        (t) =>
          t.createdAt.getTime() < now.getTime() - t.retentionDays * 24 * 3600 * 1000 &&
          // Legal hold on a same-tenant recording for this call's CallSid.
          !this.rows.some(
            (r) => r.tenantId === t.tenantId && r.callSid === t.callSid && r.legalHold,
          ),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findTenantsWithDueUnattachedTurns(now: Date, limit: number): Promise<string[]> {
    return [...new Set(this.dueUnattachedTurns(now).map((t) => t.tenantId))].slice(0, limit);
  }

  async purgeUnattachedTurns(
    tenantId: string,
    now: Date,
    limit: number,
  ): Promise<PurgedUnattachedCall[]> {
    const doomed = this.dueUnattachedTurns(now)
      .filter((t) => t.tenantId === tenantId)
      .slice(0, limit);
    this.unattachedTurns = this.unattachedTurns.filter((t) => !doomed.includes(t));
    return groupPurgedTurnsByCall(doomed);
  }

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
  /** #1202 — unattached transcript turns deleted per tenant per sweep. */
  unattachedTurnBatchSize?: number;
  /** #1208 — voice_sessions transcripts cleared per tenant per sweep. */
  sessionTranscriptBatchSize?: number;
  now?: () => Date;
}

export interface RecordingRetentionSweepResult {
  due: number;
  purged: number;
  failed: number;
  /** #1202 — call_transcript_turns rows with no recording deleted past the horizon. */
  unattachedTurnsPurged: number;
  /** #1202 — tenants whose unattached-turn purge failed (retried next sweep). */
  unattachedTurnTenantsFailed: number;
  /** #1208 — voice_sessions transcripts cleared past the horizon. */
  sessionTranscriptsPurged: number;
  /** #1208 — tenants whose session-transcript clear failed (retried next sweep). */
  sessionTranscriptTenantsFailed: number;
}

/**
 * #1202 — the unattached-turn phase of the sweep. A tenant whose purge fails
 * is logged and keeps its rows for the next sweep; the other tenants continue.
 * Never throws.
 */
async function purgeUnattachedTranscriptTurns(
  deps: RecordingRetentionWorkerDeps,
  now: () => Date,
): Promise<
  Pick<RecordingRetentionSweepResult, 'unattachedTurnsPurged' | 'unattachedTurnTenantsFailed'>
> {
  const batchSize = deps.unattachedTurnBatchSize ?? UNATTACHED_TURN_SWEEP_BATCH;
  let tenantIds: string[];
  try {
    tenantIds = await deps.repo.findTenantsWithDueUnattachedTurns(
      now(),
      UNATTACHED_TURN_SWEEP_TENANT_LIMIT,
    );
  } catch (err) {
    deps.logger.error('recording-retention sweep: unattached-turn tenant selection failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { unattachedTurnsPurged: 0, unattachedTurnTenantsFailed: 0 };
  }

  let unattachedTurnsPurged = 0;
  let unattachedTurnTenantsFailed = 0;
  for (const tenantId of tenantIds) {
    let calls: PurgedUnattachedCall[];
    try {
      calls = await deps.repo.purgeUnattachedTurns(tenantId, now(), batchSize);
    } catch (err) {
      unattachedTurnTenantsFailed++;
      deps.logger.warn('recording-retention sweep: unattached-turn purge failed for tenant', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const call of calls) {
      unattachedTurnsPurged += call.transcriptTurns;
      if (!deps.auditRepo) continue;
      try {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: 'recording-retention-worker',
            actorRole: 'system',
            eventType: 'voice_session.transcript_purged',
            entityType: call.callSid ? 'voice_session' : 'tenant',
            entityId: call.callSid ?? tenantId,
            metadata: {
              callSid: call.callSid,
              reason: 'no_recording_past_retention',
              oldestTurnAt: call.oldestTurnAt.toISOString(),
              derivedPurged: { transcriptTurns: call.transcriptTurns },
            },
          }),
        );
      } catch (err) {
        // Best-effort: the rows are already gone, so the purge stands, but a
        // missing audit row must not be silent.
        deps.logger.warn('recording-retention sweep: unattached-turn audit write failed', {
          tenantId,
          callSid: call.callSid,
          transcriptTurns: call.transcriptTurns,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { unattachedTurnsPurged, unattachedTurnTenantsFailed };
}

/**
 * #1208 — the voice_sessions.transcript phase of the sweep. Same failure
 * isolation as the unattached-turn phase. Never throws.
 */
async function purgeSessionTranscripts(
  deps: RecordingRetentionWorkerDeps,
  now: () => Date,
): Promise<
  Pick<RecordingRetentionSweepResult, 'sessionTranscriptsPurged' | 'sessionTranscriptTenantsFailed'>
> {
  const batchSize = deps.sessionTranscriptBatchSize ?? SESSION_TRANSCRIPT_SWEEP_BATCH;
  let tenantIds: string[];
  try {
    tenantIds = await deps.repo.findTenantsWithDueSessionTranscripts(
      now(),
      SESSION_TRANSCRIPT_SWEEP_TENANT_LIMIT,
    );
  } catch (err) {
    deps.logger.error('recording-retention sweep: session-transcript tenant selection failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { sessionTranscriptsPurged: 0, sessionTranscriptTenantsFailed: 0 };
  }

  let sessionTranscriptsPurged = 0;
  let sessionTranscriptTenantsFailed = 0;
  for (const tenantId of tenantIds) {
    let cleared: PurgedSessionTranscript[];
    try {
      cleared = await deps.repo.purgeSessionTranscripts(tenantId, now(), batchSize);
    } catch (err) {
      sessionTranscriptTenantsFailed++;
      deps.logger.warn('recording-retention sweep: session-transcript purge failed for tenant', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    sessionTranscriptsPurged += cleared.length;
    if (!deps.auditRepo) continue;
    for (const session of cleared) {
      try {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: 'recording-retention-worker',
            actorRole: 'system',
            eventType: 'voice_session.transcript_purged',
            entityType: 'voice_session',
            entityId: session.sessionId,
            metadata: {
              callSid: session.callSid,
              reason: 'session_transcript_past_retention',
              startedAt: session.startedAt.toISOString(),
              derivedPurged: { sessionTranscriptLines: session.transcriptLines },
            },
          }),
        );
      } catch (err) {
        deps.logger.warn('recording-retention sweep: session-transcript audit write failed', {
          tenantId,
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { sessionTranscriptsPurged, sessionTranscriptTenantsFailed };
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
    // #1202 — a separate selection; a failed recording query doesn't skip it.
    const unattached = await purgeUnattachedTranscriptTurns(deps, now);
    const sessions = await purgeSessionTranscripts(deps, now);
    return { due: 0, purged: 0, failed: 0, ...unattached, ...sessions };
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

  // #1202 — turns that never got a recording (never reached by the drain
  // above, which only deletes turns linked to a due recording).
  const unattached = await purgeUnattachedTranscriptTurns(deps, now);
  // #1208 — the session-row copy of the transcript, with or without a recording.
  const sessions = await purgeSessionTranscripts(deps, now);

  deps.logger.info('recording-retention sweep completed', {
    due: due.length,
    purged,
    failed,
    ...unattached,
    ...sessions,
  });
  return { due: due.length, purged, failed, ...unattached, ...sessions };
}
