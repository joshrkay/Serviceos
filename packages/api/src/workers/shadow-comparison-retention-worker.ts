/**
 * #1813 follow-up — shadow-comparison retention sweep.
 *
 * `shadow_comparisons` (migration 352) holds the PII-scrubbed primary and
 * shadow LLM reply text for every SAMPLED call while SHADOW_LLM_ENABLED is on
 * (ai/evaluation/pg-shadow-comparison.ts). The store calls scrubPii with no
 * known entities, so only phone numbers, emails, street addresses and card
 * numbers are replaced; names and the rest of what a caller said survive, and
 * keeping the rows forever is a data-minimisation gap. This sweep deletes
 * every row whose `created_at` is older than SHADOW_COMPARISON_RETENTION_DAYS.
 *
 * Window: one platform-wide value (config, default 365). 365 is the platform
 * default of `tenant_settings.recording_retention_days`, the horizon past which
 * the recording-retention sweep strips `ai_runs` prompt and reply content
 * (PRIV-1) — the closest existing AI-content retention window, and the same
 * kind of data (model replies to tenant calls). It is not the tenant's own
 * horizon: the placeholder bucket has no tenant_settings row, and a
 * tenant-driven selection would never reach it or a row whose tenant is gone
 * (the table has no tenants FK). Nothing writes recording_retention_days today
 * (no settings route, migration 169's note), so every tenant is at 365; an
 * operator who shortens a tenant's horizon should shorten this window too.
 *
 * Deleted, not tombstoned: the rows are evaluation samples with no reader but
 * the owner/admin list route, and nothing references them.
 *
 * Legal hold: exempt, as in every phase of the recording-retention sweep. A
 * row is the same kind of content PRIV-1 strips from `ai_runs` (a model reply
 * to the call, here scrubbed), and like `ai_runs` it carries no CallSid or
 * session key (`ai_run_id` stays NULL, see pg-shadow-comparison.ts). So the
 * PRIV-1 probe applies as is: a row created within a day of a same-tenant
 * recording on legal hold is treated as that call's and kept; the tenant's
 * other due rows are still deleted. The window can also keep another call's
 * row from the same day, which errs toward the hold. The probe sits in both
 * the tenant selection (a tenant whose only due rows are held takes no slot,
 * and its MIN(created_at) does not rank it) and the DELETE, and migration
 * 321's partial index idx_voice_recordings_legal_hold serves it. The
 * placeholder bucket has no recordings, so nothing in it is ever held.
 *
 * Shape: the PRIV-1 / #1208 phases of recording-retention-worker.ts.
 *   - Selection is cross-tenant (`withCrossTenantSweep`, the named
 *     `rls_cross_tenant` role under RLS_RUNTIME_ROLE): the tenants holding
 *     due rows, oldest backlog first, at most
 *     SHADOW_COMPARISON_RETENTION_SWEEP_TENANT_LIMIT per sweep. Driven from
 *     shadow_comparisons itself, so the all-zero placeholder bucket that
 *     platform ('system') calls are filed under is reached like any tenant.
 *     Migration 353's idx_shadow_comparisons_created (created_at, tenant_id)
 *     serves it as an index-only range scan over the due rows alone (each
 *     probed against the legal-hold index), so the hourly cost follows what
 *     is due, not the table's size: in steady state, the rows that aged past
 *     the window since the last sweep plus any held ones. A backlog costs
 *     one pass over its rows per sweep until it drains.
 *   - Each tenant's DELETE is tenant-scoped (`withTenantTransaction`, RLS on
 *     app.current_tenant_id plus `tenant_id = $1`), at most `batchSize` rows,
 *     oldest first. A backlog drains across hourly sweeps.
 *   - One tenant's failure is logged and retried next sweep; the rest
 *     continue. Never throws.
 *   - One `shadow_comparison.purged` audit event per tenant batch, except for
 *     the placeholder bucket (audit_events.tenant_id references tenants and
 *     the placeholder has no row; its purges show in the completion log).
 *     The owner's activity feed (GET /api/analytics/activity) leaves the
 *     event out: hourly internal housekeeping, not something the owner did
 *     or needs to act on.
 *
 * Not gated on SHADOW_LLM_ENABLED: rows written while the flag was on must
 * still age out after it is turned off. app.ts drives the hourly cadence
 * behind `runAsLeader` (SWEEP_LOCK.shadowComparisonRetention = 590047).
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import type { Logger } from '../logging/logger';
import { PLACEHOLDER_TENANT_ID } from '../ai/evaluation/pg-shadow-comparison';
import { shadowComparisonsPurgedTotal } from '../monitoring/metrics';

/** Tenants (the placeholder bucket included) served per sweep. */
export const SHADOW_COMPARISON_RETENTION_SWEEP_TENANT_LIMIT = 100;

/** Rows deleted per tenant per sweep. */
export const SHADOW_COMPARISON_RETENTION_SWEEP_BATCH = 500;

const RETENTION_ACTOR = 'shadow-comparison-retention-worker';

/**
 * The audit event type of one tenant batch. Internal housekeeping: the
 * owner's activity feed leaves it out (analytics/activity-feed.ts).
 */
export const SHADOW_COMPARISON_PURGED_EVENT = 'shadow_comparison.purged';

/**
 * The PRIV-1 legal-hold probe (recording-retention-worker.ts,
 * HELD_CALL_WINDOW_PROBE) over `shadow_comparisons sc`: a same-tenant
 * recording on legal hold within a day of the row. Served by the
 * migration-321 partial index idx_voice_recordings_legal_hold
 * (tenant_id, created_at) WHERE legal_hold.
 */
const HELD_CALL_WINDOW_PROBE = `SELECT 1
                   FROM voice_recordings vr
                  WHERE vr.tenant_id = sc.tenant_id
                    AND vr.legal_hold
                    AND vr.created_at BETWEEN sc.created_at - interval '1 day'
                                          AND sc.created_at + interval '1 day'`;

/** One deleted row, for the audit metadata. */
export interface PurgedShadowComparison {
  taskType: string | null;
  createdAt: Date;
}

export interface ShadowComparisonRetentionRepository {
  /**
   * Cross-tenant: tenant ids holding a row older than `retentionDays` before
   * `now` that no legal hold keeps, oldest such backlog first, at most `limit`.
   */
  findTenantsWithDue(now: Date, retentionDays: number, limit: number): Promise<string[]>;
  /**
   * Delete up to `limit` of the tenant's rows older than `retentionDays`
   * before `now` that no legal hold keeps, oldest first, in one tenant-scoped
   * transaction.
   */
  purgeDue(
    tenantId: string,
    now: Date,
    retentionDays: number,
    limit: number,
  ): Promise<PurgedShadowComparison[]>;
}

/**
 * The cross-tenant selection: $1 now, $2 retention days, $3 tenant limit.
 * Exported so the integration test EXPLAINs the exact SQL that runs.
 */
export const FIND_TENANTS_WITH_DUE_SQL = `SELECT sc.tenant_id
           FROM shadow_comparisons sc
          WHERE sc.created_at < $1::timestamptz - make_interval(days => $2::int)
            AND NOT EXISTS (${HELD_CALL_WINDOW_PROBE})
          GROUP BY sc.tenant_id
          ORDER BY MIN(sc.created_at) ASC
          LIMIT $3`;

export class PgShadowComparisonRetentionRepository
  extends PgBaseRepository
  implements ShadowComparisonRetentionRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async findTenantsWithDue(now: Date, retentionDays: number, limit: number): Promise<string[]> {
    return this.withCrossTenantSweep(async (client) => {
      const { rows } = await client.query(FIND_TENANTS_WITH_DUE_SQL, [now, retentionDays, limit]);
      return rows.map((row) => String(row.tenant_id));
    });
  }

  async purgeDue(
    tenantId: string,
    now: Date,
    retentionDays: number,
    limit: number,
  ): Promise<PurgedShadowComparison[]> {
    // shadow_comparisons is FORCE RLS on app.current_tenant_id; the
    // `tenant_id = $1` predicates are defense in depth.
    return this.withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query(
        `DELETE FROM shadow_comparisons s
          USING (
            SELECT sc.id
              FROM shadow_comparisons sc
             WHERE sc.tenant_id = $1
               AND sc.created_at < $2::timestamptz - make_interval(days => $3::int)
               AND NOT EXISTS (${HELD_CALL_WINDOW_PROBE})
             ORDER BY sc.created_at ASC
             LIMIT $4
          ) due
          WHERE s.id = due.id
            AND s.tenant_id = $1
          RETURNING s.task_type, s.created_at`,
        [tenantId, now, retentionDays, limit],
      );
      return rows.map((row) => ({
        taskType: (row.task_type as string | null) ?? null,
        createdAt: new Date(row.created_at as string),
      }));
    });
  }
}

export interface ShadowComparisonRetentionSweepDeps {
  repo: ShadowComparisonRetentionRepository;
  auditRepo?: AuditRepository;
  logger: Logger;
  /** SHADOW_COMPARISON_RETENTION_DAYS — a positive whole number of days. */
  retentionDays: number;
  /** Rows deleted per tenant per sweep. */
  batchSize?: number;
  now?: () => Date;
}

export interface ShadowComparisonRetentionSweepResult {
  /** Tenants (placeholder bucket included) selected with due rows. */
  tenantsDue: number;
  /** Rows deleted. */
  purged: number;
  /** Tenants whose delete failed (retried next sweep). */
  tenantsFailed: number;
}

/** The audit metadata for one tenant batch. */
export function summarizePurgedShadowComparisons(
  rows: ReadonlyArray<PurgedShadowComparison>,
  retentionDays: number,
): Record<string, unknown> {
  const byTaskType: Record<string, number> = {};
  let oldest = rows[0].createdAt;
  let newest = rows[0].createdAt;
  for (const row of rows) {
    const key = row.taskType ?? 'unknown';
    byTaskType[key] = (byTaskType[key] ?? 0) + 1;
    if (row.createdAt < oldest) oldest = row.createdAt;
    if (row.createdAt > newest) newest = row.createdAt;
  }
  return {
    reason: 'past_retention',
    retentionDays,
    rowsPurged: rows.length,
    byTaskType,
    oldestCreatedAt: oldest.toISOString(),
    newestCreatedAt: newest.toISOString(),
  };
}

/**
 * One sweep: select the tenants with rows past the window, delete one bounded
 * batch per tenant, audit each real tenant's batch. Never throws.
 */
export async function runShadowComparisonRetentionSweep(
  deps: ShadowComparisonRetentionSweepDeps,
): Promise<ShadowComparisonRetentionSweepResult> {
  const now = deps.now ?? (() => new Date());
  const { retentionDays } = deps;
  const batchSize = deps.batchSize ?? SHADOW_COMPARISON_RETENTION_SWEEP_BATCH;
  const nothing: ShadowComparisonRetentionSweepResult = { tenantsDue: 0, purged: 0, tenantsFailed: 0 };

  // Config refuses these at boot; a window of 0 (or NaN) here would delete
  // every row, so the sweep refuses too.
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    deps.logger.error('shadow-comparison retention sweep: refusing a non-positive retention window', {
      retentionDays,
    });
    return nothing;
  }

  let tenantIds: string[];
  try {
    tenantIds = await deps.repo.findTenantsWithDue(
      now(),
      retentionDays,
      SHADOW_COMPARISON_RETENTION_SWEEP_TENANT_LIMIT,
    );
  } catch (err) {
    deps.logger.error('shadow-comparison retention sweep: tenant selection failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return nothing;
  }

  let purged = 0;
  let tenantsFailed = 0;
  for (const tenantId of tenantIds) {
    let rows: PurgedShadowComparison[];
    try {
      rows = await deps.repo.purgeDue(tenantId, now(), retentionDays, batchSize);
    } catch (err) {
      tenantsFailed++;
      deps.logger.warn('shadow-comparison retention sweep: purge failed for tenant', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (rows.length === 0) continue;
    purged += rows.length;
    shadowComparisonsPurgedTotal.inc(rows.length);
    if (!deps.auditRepo || tenantId === PLACEHOLDER_TENANT_ID) continue;
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: RETENTION_ACTOR,
          actorRole: 'system',
          eventType: SHADOW_COMPARISON_PURGED_EVENT,
          entityType: 'tenant',
          entityId: tenantId,
          metadata: summarizePurgedShadowComparisons(rows, retentionDays),
        }),
      );
    } catch (err) {
      // Best-effort: the rows are already gone, so the purge stands, but a
      // missing audit row must not be silent.
      deps.logger.warn('shadow-comparison retention sweep: audit write failed', {
        tenantId,
        rowsPurged: rows.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = { tenantsDue: tenantIds.length, purged, tenantsFailed };
  deps.logger.info('shadow-comparison retention sweep completed', { retentionDays, ...result });
  return result;
}
