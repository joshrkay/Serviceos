/**
 * FAIL-VIS — silent-failure monitor.
 *
 * WHY THIS EXISTS
 *
 * Every defect found in the 2026-07 investigation was SILENT, and the data to
 * catch all of them already existed:
 *
 *   - `supervisor_annotate` ran 26,894 times over two days and completed ZERO
 *     times. Nothing alerted; it was found by manual archaeology.
 *   - That storm exhausted the per-tenant token budget and tripped the OpenAI
 *     circuit breaker, taking `classify_intent` — the actual product path —
 *     down as collateral (1,325 of 1,563 classifications failed on 23 July).
 *   - Estimate executions failed for weeks with `execution_error` NULL and no
 *     audit event.
 *
 * `ai_runs` already records task_type/status/error/duration/tenant for every
 * gateway call, and `proposals` already records execution state. Nothing
 * watched either. This worker does.
 *
 * WHY "NON-COMPLETION" AND NOT "status = 'failed'"
 *
 * The supervisor_annotate storm would have been INVISIBLE to a plain
 * failed/total ratio: those runs never reached a terminal state at all, they
 * just never completed. So the failure-rate rule measures
 * `(total - completed) / total` over a SETTLED window — runs old enough that
 * an in-flight one is no longer a plausible explanation. Both shapes (a wall
 * of `failed`, and a wall of runs stuck at `pending`/`running`) breach, and
 * the alert details carry the breakdown so the responder knows which it is.
 *
 * RULES
 *   1. ai_task_failure_rate:<task_type> — non-completion rate over the trailing
 *      FAILURE_MONITOR_WINDOW_MIN minutes (offset by FAILURE_MONITOR_SETTLE_MIN
 *      so in-flight runs are not counted as failures), per task_type. Breaches
 *      above FAILURE_MONITOR_RATE_MAX, ONLY when the window holds at least
 *      FAILURE_MONITOR_MIN_RUNS runs for that task type — the volume floor is
 *      the whole point: 1 failure in 2 calls is noise, 500 in 600 is a fire.
 *   2. proposal_execution_stalled — proposals sitting in `executing` for longer
 *      than FAILURE_MONITOR_PROPOSAL_STALE_MIN minutes. Execution is a queued
 *      job that finishes in seconds; a stuck one means the handler died
 *      mid-flight and nothing will ever move the row.
 *   3. proposal_execution_failed_silently — proposals that reached the terminal
 *      `execution_failed` state with `execution_error` NULL. That is the exact
 *      signature that hid the estimate bug: a terminal failure state carrying
 *      no reason. Any single one is a breach; there is no benign version.
 *
 * SAFE BY CONSTRUCTION — this watches for runaway failure and must never
 * become one:
 *   - It NEVER calls the LLM gateway. It has no gateway dependency in its deps
 *     surface and imports nothing from `ai/` (asserted by a source-scan test in
 *     test/workers/failure-rate-monitor.test.ts).
 *   - Reads are bounded aggregates over indexed predicates only (migration
 *     263) — counts and a small capped sample, never a table walk.
 *   - Every rule is independently failure-soft: a read that throws is logged
 *     and skipped, never aborting the other rules. `runFailureRateMonitor`
 *     itself resolves rather than rejects on any internal error, so a fault in
 *     the check cannot escape into the sweep loop.
 *   - Repeat alerting is suppressed by the per-rule cooldown inside
 *     `alertOperator` (SLO_ALERT_COOLDOWN_MIN); the task-failure rule keys its
 *     cooldown PER TASK TYPE so one noisy task cannot mask another. Pages per
 *     tick are additionally capped at FAILURE_MONITOR_MAX_TASK_ALERTS so a
 *     platform-wide outage cannot turn the monitor into its own storm.
 *
 * Driven from app.ts on a setInterval behind the leader advisory lock
 * SWEEP_LOCK.failureMonitor (590025), the same pattern as
 * `runSupervisorAnnotationSweep` and `runSloMonitor`.
 *
 * Evaluators are exported pure functions so unit tests need no DB.
 */
import type { Logger } from '../logging/logger';
import {
  aiTaskFailureRate,
  aiTaskRunsObserved,
  proposalSilentFailureFindings,
} from '../monitoring/metrics';
import type { OperatorAlert } from '../monitoring/alert-operator';

/**
 * Evaluation cadence — every 10 minutes (leader-locked in app.ts). Slower than
 * the SLO monitor's 5 min because the default window is 30 min: three ticks
 * per window is enough to catch a storm within minutes while keeping the
 * aggregate count low.
 */
export const FAILURE_MONITOR_INTERVAL_MS = 10 * 60 * 1000;

export interface FailureMonitorThresholds {
  /** Trailing window (minutes) for the ai_runs aggregate. Default 30. */
  windowMin: number;
  /** Runs newer than this many minutes are excluded (may still be in flight). Default 5. */
  settleMin: number;
  /** Non-completion rate (0..1) above which a task type breaches. Default 0.25. */
  rateMax: number;
  /** Minimum runs for a task type in the window before it can breach. Default 20. */
  minRuns: number;
  /** Max task-failure pages emitted in a single tick. Default 3. */
  maxTaskAlerts: number;
  /** Minutes in `executing` before a proposal counts as stalled. Default 15. */
  proposalStaleMin: number;
  /** Lookback (hours) for NULL-error `execution_failed` proposals. Default 24. */
  proposalLookbackHours: number;
}

/** One `ai_runs` GROUP BY task_type row over the settled window. */
export interface TaskRunCounts {
  taskType: string;
  /** All runs created in the window. */
  total: number;
  /** Runs that reached status='completed'. */
  completed: number;
  /** Runs that reached status='failed'. */
  failed: number;
  /**
   * Runs still at 'pending'/'running' despite being past the settle offset —
   * i.e. stuck. This is the supervisor_annotate shape.
   */
  unresolved: number;
}

/** Aggregate counts for the two silent-execution proposal predicates. */
export interface ProposalExecutionCounts {
  /** Proposals in `executing` older than the staleness bound. */
  stalledExecuting: number;
  /** Proposals at `execution_failed` with `execution_error` NULL in the lookback. */
  failedWithoutError: number;
  /** Up to a handful of stalled proposal ids, for the responder. */
  stalledSampleIds: string[];
  /** Up to a handful of silently-failed proposal ids, for the responder. */
  failedSampleIds: string[];
}

export interface FailureFinding {
  /** Stable rule key — also the alertOperator cooldown key. */
  rule: string;
  breached: boolean;
  /** Value exported to the corresponding gauge. */
  value: number;
  summary: string;
  details: Record<string, string | number>;
  severity: OperatorAlert['severity'];
}

/**
 * Rule 1 — non-completion rate for ONE task type.
 *
 * Returns `null` below the volume floor: not enough calls to judge. This is
 * what keeps a 3am fluke from paging, and it is deliberately checked BEFORE
 * the rate so a 1-of-1 failure can never reach the alert path.
 */
export function evaluateTaskFailureRate(
  counts: TaskRunCounts,
  thresholds: Pick<FailureMonitorThresholds, 'rateMax' | 'minRuns' | 'windowMin'>,
): FailureFinding | null {
  if (counts.total < thresholds.minRuns) return null;
  const unsuccessful = counts.total - counts.completed;
  const rate = unsuccessful / counts.total;
  // A task type that completed NOTHING at volume is the supervisor_annotate
  // shape verbatim — call it out in the summary so the page is self-explaining.
  const shape =
    counts.completed === 0
      ? 'ZERO completions'
      : `${counts.failed} failed / ${counts.unresolved} stuck`;
  return {
    rule: `ai_task_failure_rate:${counts.taskType}`,
    breached: rate > thresholds.rateMax,
    value: rate,
    summary:
      `ai task '${counts.taskType}' non-completion ${(rate * 100).toFixed(1)}% ` +
      `(${unsuccessful}/${counts.total} runs, ${shape}) over last ${thresholds.windowMin}min ` +
      `(threshold ${(thresholds.rateMax * 100).toFixed(0)}%)`,
    details: {
      taskType: counts.taskType,
      total: counts.total,
      completed: counts.completed,
      failed: counts.failed,
      unresolved: counts.unresolved,
      threshold: thresholds.rateMax,
      windowMin: thresholds.windowMin,
    },
    severity: 'critical',
  };
}

/**
 * Rule 2 — proposals stuck in `executing`. Any stale row is a breach: the
 * execution handler is a queued job that finishes in seconds, so a row older
 * than the bound means nothing is ever going to move it.
 */
export function evaluateStalledExecutions(
  counts: Pick<ProposalExecutionCounts, 'stalledExecuting' | 'stalledSampleIds'>,
  thresholds: Pick<FailureMonitorThresholds, 'proposalStaleMin'>,
): FailureFinding {
  return {
    rule: 'proposal_execution_stalled',
    breached: counts.stalledExecuting > 0,
    value: counts.stalledExecuting,
    summary:
      `${counts.stalledExecuting} proposal(s) stuck in 'executing' for more than ` +
      `${thresholds.proposalStaleMin}min`,
    details: {
      stalled: counts.stalledExecuting,
      staleMinutes: thresholds.proposalStaleMin,
      sampleIds: counts.stalledSampleIds.join(',') || 'none',
    },
    severity: 'critical',
  };
}

/**
 * Rule 3 — terminal `execution_failed` with NO `execution_error`. This is the
 * exact signature that hid the estimate bug for weeks: a terminal failure
 * state carrying no reason. There is no benign version, so a single row
 * breaches — but severity is 'warning', not 'critical': the work already
 * failed, and what this page buys is the DIAGNOSABILITY that was missing, not
 * a live outage response.
 */
export function evaluateSilentExecutionFailures(
  counts: Pick<ProposalExecutionCounts, 'failedWithoutError' | 'failedSampleIds'>,
  thresholds: Pick<FailureMonitorThresholds, 'proposalLookbackHours'>,
): FailureFinding {
  return {
    rule: 'proposal_execution_failed_silently',
    breached: counts.failedWithoutError > 0,
    value: counts.failedWithoutError,
    summary:
      `${counts.failedWithoutError} proposal(s) reached 'execution_failed' with a NULL ` +
      `execution_error in the last ${thresholds.proposalLookbackHours}h — terminal failure, no reason recorded`,
    details: {
      silentFailures: counts.failedWithoutError,
      lookbackHours: thresholds.proposalLookbackHours,
      sampleIds: counts.failedSampleIds.join(',') || 'none',
    },
    severity: 'warning',
  };
}

export interface FailureRateMonitorDeps {
  /**
   * Cross-tenant `ai_runs` counts grouped by task_type for runs created in
   * `[windowStart, windowEnd)`. Aggregate only — never returns rows.
   */
  getTaskRunCounts(windowStart: Date, windowEnd: Date): Promise<TaskRunCounts[]>;
  /** Cross-tenant silent-execution counts over `proposals`. */
  getProposalExecutionCounts(
    stalledBefore: Date,
    failedSince: Date,
  ): Promise<ProposalExecutionCounts>;
  /**
   * Delivery seam. In production this is the SAME `alertOperator` the SLO
   * monitor uses (Sentry error event + owner-class operator SMS), which owns
   * the per-rule cooldown and never throws.
   */
  alert(alert: OperatorAlert): Promise<void>;
  thresholds: FailureMonitorThresholds;
  logger: Logger;
  now?: () => Date;
}

export interface FailureRateMonitorRunResult {
  evaluated: string[];
  breached: string[];
  /** Rules that breached but were dropped by the per-tick alert cap. */
  suppressedByCap: string[];
}

/**
 * One evaluation tick.
 *
 * NEVER REJECTS. Every read is individually guarded, and the whole body is
 * wrapped so that a fault anywhere (including in the alert seam or the metrics
 * registry) is logged and swallowed. The caller in app.ts additionally
 * `.catch()`es, but the guarantee lives here so any caller is safe.
 */
export async function runFailureRateMonitor(
  deps: FailureRateMonitorDeps,
): Promise<FailureRateMonitorRunResult> {
  const evaluated: string[] = [];
  const breached: string[] = [];
  const suppressedByCap: string[] = [];

  try {
    const now = deps.now ?? (() => new Date());
    const nowMs = now().getTime();
    const t = deps.thresholds;
    const findings: FailureFinding[] = [];

    // ── Rule 1 — per-task non-completion rate over the SETTLED window. ──────
    // windowEnd is offset back by settleMin so runs that may legitimately
    // still be in flight are never counted as failures.
    try {
      const windowEnd = new Date(nowMs - t.settleMin * 60 * 1000);
      const windowStart = new Date(windowEnd.getTime() - t.windowMin * 60 * 1000);
      const rows = await deps.getTaskRunCounts(windowStart, windowEnd);
      for (const row of rows) {
        setGauge(() => aiTaskRunsObserved.set({ task_type: row.taskType }, row.total), deps.logger);
        const finding = evaluateTaskFailureRate(row, t);
        // Below the volume floor there is no rate worth publishing — emitting
        // one would make the gauge swing wildly on tiny denominators.
        if (!finding) continue;
        setGauge(
          () => aiTaskFailureRate.set({ task_type: row.taskType }, finding.value),
          deps.logger,
        );
        findings.push(finding);
      }
      evaluated.push('ai_task_failure_rate');
    } catch (err) {
      deps.logger.error('Failure monitor: ai_runs aggregate failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Rules 2 + 3 — silent proposal-execution failures. ───────────────────
    try {
      const stalledBefore = new Date(nowMs - t.proposalStaleMin * 60 * 1000);
      const failedSince = new Date(nowMs - t.proposalLookbackHours * 60 * 60 * 1000);
      const counts = await deps.getProposalExecutionCounts(stalledBefore, failedSince);
      setGauge(
        () =>
          proposalSilentFailureFindings.set(
            { check: 'stalled_executing' },
            counts.stalledExecuting,
          ),
        deps.logger,
      );
      setGauge(
        () =>
          proposalSilentFailureFindings.set(
            { check: 'failed_without_error' },
            counts.failedWithoutError,
          ),
        deps.logger,
      );
      findings.push(evaluateStalledExecutions(counts, t));
      findings.push(evaluateSilentExecutionFailures(counts, t));
      evaluated.push('proposal_execution_stalled', 'proposal_execution_failed_silently');
    } catch (err) {
      deps.logger.error('Failure monitor: proposal execution read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Dispatch. ───────────────────────────────────────────────────────────
    // Task-failure pages are capped per tick (worst-first) so a platform-wide
    // outage that breaches every task type at once cannot turn this monitor
    // into the storm it exists to detect. The proposal rules are two fixed
    // keys and are never capped. Everything breached is LOGGED regardless —
    // the cap limits paging, never visibility.
    const taskBreaches = findings
      .filter((f) => f.breached && f.rule.startsWith('ai_task_failure_rate:'))
      .sort((a, b) => b.value - a.value);
    const otherBreaches = findings.filter(
      (f) => f.breached && !f.rule.startsWith('ai_task_failure_rate:'),
    );

    for (const f of taskBreaches.slice(t.maxTaskAlerts)) {
      suppressedByCap.push(f.rule);
    }
    if (suppressedByCap.length > 0) {
      deps.logger.warn('Failure monitor: task-failure pages capped for this tick', {
        cap: t.maxTaskAlerts,
        suppressed: suppressedByCap,
      });
    }

    for (const f of [...taskBreaches.slice(0, t.maxTaskAlerts), ...otherBreaches]) {
      breached.push(f.rule);
      try {
        // alertOperator owns the per-rule cooldown and never throws; the guard
        // is for a test double or a future channel that might.
        await deps.alert({
          severity: f.severity,
          rule: f.rule,
          summary: f.summary,
          details: f.details,
        });
      } catch (err) {
        deps.logger.error('Failure monitor: alert dispatch failed', {
          rule: f.rule,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    breached.push(...suppressedByCap);

    if (breached.length > 0) {
      deps.logger.warn('Failure monitor: silent failures detected', { breached });
    }
  } catch (err) {
    // Absolute backstop. A monitor that can crash the app is worse than no
    // monitor — this is the whole reason the check is allowed to be wrong.
    try {
      deps.logger.error('Failure monitor tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // logger itself failed — nothing left to do but not throw.
    }
  }

  return { evaluated, breached, suppressedByCap };
}

/**
 * Set a Prometheus gauge without letting a registry error abort the tick.
 * Telemetry is the least important thing this worker does.
 */
function setGauge(fn: () => void, logger: Logger): void {
  try {
    fn();
  } catch (err) {
    logger.error('Failure monitor: gauge update failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
