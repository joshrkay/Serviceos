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
 *   4. ai_task_failure_rate:<task_type>:<tenant_id> — OBS-4. Rule 1 is a
 *      cross-tenant aggregate, so ONE tenant's total outage (its quota bucket
 *      rejecting every classify, say) is diluted by healthy tenants' traffic
 *      and never breaches unless that tenant is more than rateMax of platform
 *      volume. This is the same non-completion rate over the same settled
 *      window, grouped by tenant AND task, behind its own smaller floor
 *      (FAILURE_MONITOR_TENANT_MIN_RUNS). When rule 1 already breaches for a
 *      task type, the per-tenant breaches of that task are SUBSUMED (logged,
 *      not paged): the platform page is the self-explaining one, and this
 *      rule exists only for the diluted case.
 *   5. ai_spend_window — OBS-4. Platform-wide SUM(ai_runs.cost_micro_cents)
 *      over the same settled window against FAILURE_MONITOR_SPEND_MAX_CENTS.
 *      A sweep that regresses into re-calling the model in a loop but
 *      COMPLETING every call (the supervisor_annotate storm shape, succeeding)
 *      keeps rule 1 at 0% and is invisible to it; only the bill moves. The
 *      page names the top tenants and task types by spend. Keyed on the
 *      cross-tenant total because per-tenant spend is already bounded by the
 *      gateway's quota buckets; a loop that fans out across tenants is not.
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
 *     cooldown PER TASK TYPE (and the per-tenant rule per task AND tenant) so
 *     one noisy task or tenant cannot mask another. Pages per tick are
 *     additionally capped at FAILURE_MONITOR_MAX_TASK_ALERTS — separately for
 *     the platform rule and the per-tenant rule — so a platform-wide outage
 *     cannot turn the monitor into its own storm.
 *
 * Driven from app.ts on a setInterval behind the leader advisory lock
 * SWEEP_LOCK.failureMonitor (590025), the same pattern as
 * `runSupervisorAnnotationSweep` and `runSloMonitor`.
 *
 * Evaluators are exported pure functions so unit tests need no DB.
 */
import type { Logger } from '../logging/logger';
import {
  aiSpendWindowMicroCents,
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
  /**
   * OBS-4 — minimum runs for ONE tenant+task in the window before the
   * per-tenant rule can breach. Default 10: a single tenant's volume is a
   * fraction of the platform's, so the platform floor would silence it.
   */
  tenantMinRuns: number;
  /**
   * OBS-4 — platform-wide spend (integer cents) over the window above which
   * `ai_spend_window` breaches. 0 turns the rule off. Default 2000 ($20).
   */
  spendMaxCents: number;
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

/**
 * OBS-4 — one `ai_runs` GROUP BY tenant_id, task_type row over the settled
 * window. Same counts as TaskRunCounts plus the tenant and the window spend.
 */
export interface TenantTaskRunCounts extends TaskRunCounts {
  tenantId: string;
  /**
   * SUM(cost_micro_cents) for this tenant+task in the window. Unpriced runs
   * (NULL cost — an unknown model price) contribute 0, never a guess, so a
   * spend page can under-count but never fabricate.
   */
  costMicroCents: number;
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
 * Rule 4 (OBS-4) — non-completion rate for ONE tenant's ONE task type. Same
 * arithmetic as rule 1 behind the tenant floor; the rule key carries the
 * tenant so the alertOperator cooldown is per tenant AND task.
 */
export function evaluateTenantTaskFailureRate(
  counts: TenantTaskRunCounts,
  thresholds: Pick<FailureMonitorThresholds, 'rateMax' | 'tenantMinRuns' | 'windowMin'>,
): FailureFinding | null {
  if (counts.total < thresholds.tenantMinRuns) return null;
  const unsuccessful = counts.total - counts.completed;
  const rate = unsuccessful / counts.total;
  const shape =
    counts.completed === 0
      ? 'ZERO completions'
      : `${counts.failed} failed / ${counts.unresolved} stuck`;
  return {
    rule: `ai_task_failure_rate:${counts.taskType}:${counts.tenantId}`,
    breached: rate > thresholds.rateMax,
    value: rate,
    summary:
      `ai task '${counts.taskType}' non-completion ${(rate * 100).toFixed(1)}% for ONE tenant ` +
      `${counts.tenantId} (${unsuccessful}/${counts.total} runs, ${shape}) over last ` +
      `${thresholds.windowMin}min (threshold ${(thresholds.rateMax * 100).toFixed(0)}%) — ` +
      `platform-wide rate for this task is below threshold`,
    details: {
      tenantId: counts.tenantId,
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

/** Micro-cents per cent (ai_runs.cost_micro_cents; see ai/gateway/model-pricing.ts). */
const MICRO_CENTS_PER_CENT = 1_000_000;
/** How many tenants / task types the spend page names, worst first. */
const SPEND_TOP_N = 3;

/**
 * Rule 5 (OBS-4) — platform-wide spend over the window. Returns `null` when
 * the rule is turned off (spendMaxCents 0). The threshold is integer cents
 * (how operators think); the aggregate is micro-cents (how the gateway
 * prices), compared without division so no rounding can hide a breach.
 */
export function evaluateWindowSpend(
  rows: ReadonlyArray<Pick<TenantTaskRunCounts, 'tenantId' | 'taskType' | 'costMicroCents'>>,
  thresholds: Pick<FailureMonitorThresholds, 'spendMaxCents' | 'windowMin'>,
): FailureFinding | null {
  if (thresholds.spendMaxCents <= 0) return null;
  const thresholdMicroCents = thresholds.spendMaxCents * MICRO_CENTS_PER_CENT;
  let totalMicroCents = 0;
  const byTenant = new Map<string, number>();
  const byTask = new Map<string, number>();
  for (const r of rows) {
    totalMicroCents += r.costMicroCents;
    byTenant.set(r.tenantId, (byTenant.get(r.tenantId) ?? 0) + r.costMicroCents);
    byTask.set(r.taskType, (byTask.get(r.taskType) ?? 0) + r.costMicroCents);
  }
  const top = (m: Map<string, number>): string =>
    [...m.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SPEND_TOP_N)
      .map(([k, v]) => `${k}=${(v / MICRO_CENTS_PER_CENT).toFixed(2)}c`)
      .join(',') || 'none';
  const totalCents = totalMicroCents / MICRO_CENTS_PER_CENT;
  return {
    rule: 'ai_spend_window',
    breached: totalMicroCents > thresholdMicroCents,
    value: totalMicroCents,
    summary:
      `ai spend ${totalCents.toFixed(2)} cents over last ${thresholds.windowMin}min ` +
      `(threshold ${thresholds.spendMaxCents} cents) — ` +
      `top tenants ${top(byTenant)}; top tasks ${top(byTask)}`,
    details: {
      totalCents: Number(totalCents.toFixed(2)),
      thresholdCents: thresholds.spendMaxCents,
      windowMin: thresholds.windowMin,
      topTenants: top(byTenant),
      topTaskTypes: top(byTask),
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
  /**
   * OBS-4 — the same window grouped by tenant_id AND task_type, with the
   * window spend per row. Feeds the per-tenant rule and the spend rule from
   * ONE aggregate read. Aggregate only — never returns rows.
   */
  getTenantTaskRunCounts(windowStart: Date, windowEnd: Date): Promise<TenantTaskRunCounts[]>;
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

    // The SETTLED window shared by every ai_runs rule: windowEnd is offset
    // back by settleMin so runs that may legitimately still be in flight are
    // never counted as failures.
    const windowEnd = new Date(nowMs - t.settleMin * 60 * 1000);
    const windowStart = new Date(windowEnd.getTime() - t.windowMin * 60 * 1000);

    // ── Rule 1 — per-task non-completion rate over the SETTLED window. ──────
    try {
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

    // ── Rules 4 + 5 (OBS-4) — per-tenant non-completion and platform spend,
    // from ONE per-tenant aggregate over the same settled window. ────────────
    try {
      const rows = await deps.getTenantTaskRunCounts(windowStart, windowEnd);
      for (const row of rows) {
        const finding = evaluateTenantTaskFailureRate(row, t);
        if (!finding) continue;
        findings.push(finding);
      }
      evaluated.push('ai_tenant_task_failure_rate');
      const spend = evaluateWindowSpend(rows, t);
      if (spend) {
        setGauge(() => aiSpendWindowMicroCents.set(spend.value), deps.logger);
        findings.push(spend);
        evaluated.push('ai_spend_window');
      }
    } catch (err) {
      deps.logger.error('Failure monitor: per-tenant ai_runs aggregate failed', {
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
    // into the storm it exists to detect. Per-tenant pages get their own cap
    // of the same size, and a per-tenant breach of a task type that ALREADY
    // breached platform-wide is subsumed: the platform page explains it, and
    // a platform outage must not fan out into one page per tenant. The
    // proposal and spend rules are fixed keys and are never capped.
    // Everything breached is LOGGED regardless — the cap limits paging, never
    // visibility.
    const isTaskRule = (f: FailureFinding): boolean => f.rule.startsWith('ai_task_failure_rate:');
    const isTenantRule = (f: FailureFinding): boolean => isTaskRule(f) && 'tenantId' in f.details;
    const taskBreaches = findings
      .filter((f) => f.breached && isTaskRule(f) && !isTenantRule(f))
      .sort((a, b) => b.value - a.value);
    const platformBreachedTasks = new Set(taskBreaches.map((f) => String(f.details.taskType)));
    const subsumedByPlatform: string[] = [];
    const tenantBreaches = findings
      .filter((f) => f.breached && isTenantRule(f))
      .filter((f) => {
        if (!platformBreachedTasks.has(String(f.details.taskType))) return true;
        subsumedByPlatform.push(f.rule);
        return false;
      })
      .sort((a, b) => b.value - a.value);
    const otherBreaches = findings.filter((f) => f.breached && !isTaskRule(f));

    for (const f of taskBreaches.slice(t.maxTaskAlerts)) {
      suppressedByCap.push(f.rule);
    }
    for (const f of tenantBreaches.slice(t.maxTaskAlerts)) {
      suppressedByCap.push(f.rule);
    }
    if (suppressedByCap.length > 0) {
      deps.logger.warn('Failure monitor: task-failure pages capped for this tick', {
        cap: t.maxTaskAlerts,
        suppressed: suppressedByCap,
      });
    }
    if (subsumedByPlatform.length > 0) {
      deps.logger.warn('Failure monitor: per-tenant breaches subsumed by a platform-wide breach', {
        subsumed: subsumedByPlatform,
      });
    }

    for (const f of [
      ...taskBreaches.slice(0, t.maxTaskAlerts),
      ...tenantBreaches.slice(0, t.maxTaskAlerts),
      ...otherBreaches,
    ]) {
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

    breached.push(...suppressedByCap, ...subsumedByPlatform);

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
