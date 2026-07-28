/**
 * FAIL-VIS — cross-tenant reads for the silent-failure monitor
 * (workers/failure-rate-monitor.ts).
 *
 * `ai_runs` and `proposals` are both tenant-scoped (RLS), and these are
 * PLATFORM aggregates, so this repository uses `withCrossTenantSweep` — the
 * same intentional cross-tenant seam the SLO monitor / proposal-execution /
 * retention sweeps use (named, auditable `rls_cross_tenant` role when
 * RLS_RUNTIME_ROLE is on; falls back to the connection principal otherwise).
 *
 * COST DISCIPLINE. This monitor exists because a runaway task type went
 * unnoticed; it must not itself add load during exactly that storm. Every
 * query here is an aggregate over a bounded, indexed predicate (migration 263
 * `263_failure_monitor_indexes`):
 *   - the ai_runs aggregate is a half-open created_at range served by an
 *     INCLUDE index, so it is an index-ONLY scan (no heap access);
 *   - both proposal probes hit PARTIAL indexes whose WHERE clause matches the
 *     query predicate exactly, so on a healthy system they touch ~0 rows;
 *   - the only non-aggregate reads are id samples with a hard LIMIT.
 * No query returns an unbounded row set.
 */
import { PgBaseRepository } from '../db/pg-base';
import type {
  ProposalExecutionCounts,
  TaskRunCounts,
} from '../workers/failure-rate-monitor';

/** Hard cap on sample ids returned per proposal check — context, not a listing. */
const SAMPLE_LIMIT = 5;

export class PgFailureMonitorRepository extends PgBaseRepository {
  /**
   * Per-task-type run counts across ALL tenants for runs created in the
   * half-open interval `[windowStart, windowEnd)`.
   *
   * `windowEnd` is deliberately in the past (the settle offset) so runs that
   * may still legitimately be in flight are outside the window and cannot be
   * miscounted as stuck. `unresolved` is the pending/running remainder —
   * the shape that made the supervisor_annotate storm invisible to any
   * failed/total ratio.
   */
  async taskRunCounts(windowStart: Date, windowEnd: Date): Promise<TaskRunCounts[]> {
    return this.withCrossTenantSweep(async (client) => {
      const res = await client.query<{
        task_type: string;
        total: string;
        completed: string;
        failed: string;
        unresolved: string;
      }>(
        `SELECT
           task_type,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'completed') AS completed,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed,
           COUNT(*) FILTER (WHERE status IN ('pending', 'running')) AS unresolved
         FROM ai_runs
         WHERE created_at >= $1
           AND created_at < $2
         GROUP BY task_type`,
        [windowStart, windowEnd],
      );
      return res.rows.map((r) => ({
        taskType: r.task_type,
        total: Number(r.total),
        completed: Number(r.completed),
        failed: Number(r.failed),
        unresolved: Number(r.unresolved),
      }));
    });
  }

  /**
   * The two silent-execution-failure predicates over `proposals`, across all
   * tenants, in ONE round trip:
   *
   *   - stalled: `status = 'executing'` with `updated_at < stalledBefore`.
   *     Execution is a queued job that finishes in seconds, so a row past the
   *     bound means the handler died mid-flight and nothing will move it.
   *   - silent: `status = 'execution_failed'` with `execution_error IS NULL`
   *     since `failedSince`. A terminal failure state carrying no reason —
   *     the exact shape that hid the estimate bug for weeks.
   *
   * The `failedSince` lookback bounds the silent check so a historical row
   * cannot pin the alert on forever; the stalled check needs no lower bound
   * (a row stuck in `executing` is a live problem however old it is) but is
   * still index-served and returns only a count plus a capped id sample.
   */
  async proposalExecutionCounts(
    stalledBefore: Date,
    failedSince: Date,
  ): Promise<ProposalExecutionCounts> {
    return this.withCrossTenantSweep(async (client) => {
      const counts = await client.query<{ stalled: string; silent: string }>(
        `SELECT
           COUNT(*) FILTER (
             WHERE status = 'executing' AND updated_at < $1
           ) AS stalled,
           COUNT(*) FILTER (
             WHERE status = 'execution_failed'
               AND execution_error IS NULL
               AND updated_at >= $2
           ) AS silent
         FROM proposals
         WHERE (status = 'executing' AND updated_at < $1)
            OR (status = 'execution_failed' AND execution_error IS NULL AND updated_at >= $2)`,
        [stalledBefore, failedSince],
      );

      const stalledExecuting = Number(counts.rows[0]?.stalled ?? 0);
      const failedWithoutError = Number(counts.rows[0]?.silent ?? 0);

      // Sample ids ONLY when there is something to sample — a healthy tick
      // issues exactly one query.
      const stalledSampleIds =
        stalledExecuting > 0
          ? (
              await client.query<{ id: string }>(
                `SELECT id FROM proposals
                 WHERE status = 'executing' AND updated_at < $1
                 ORDER BY updated_at ASC
                 LIMIT $2`,
                [stalledBefore, SAMPLE_LIMIT],
              )
            ).rows.map((r) => r.id)
          : [];

      const failedSampleIds =
        failedWithoutError > 0
          ? (
              await client.query<{ id: string }>(
                `SELECT id FROM proposals
                 WHERE status = 'execution_failed'
                   AND execution_error IS NULL
                   AND updated_at >= $1
                 ORDER BY updated_at DESC
                 LIMIT $2`,
                [failedSince, SAMPLE_LIMIT],
              )
            ).rows.map((r) => r.id)
          : [];

      return { stalledExecuting, failedWithoutError, stalledSampleIds, failedSampleIds };
    });
  }
}
