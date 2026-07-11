/**
 * WS15 — platform SLO monitor.
 *
 * Evaluates a small set of platform SLOs on an interval (~5 min, leader-locked
 * in app.ts under SWEEP_LOCK.sloMonitor) and ALERTS A HUMAN on breach via
 * `alertOperator` (Sentry error event + optional operator SMS). This closes
 * the gap where /metrics exported signals but nothing evaluated them.
 *
 * Rules shipped:
 *   1. call_completion_rate — completed-ish terminal outcomes / all ended
 *      voice sessions in the last 60 min (source of truth: voice_sessions,
 *      cross-tenant). Breach below SLO_CALL_COMPLETION_MIN (default 0.85),
 *      ONLY when the window has >= SLO_CALL_COMPLETION_MIN_SAMPLE (default 5)
 *      ended calls — the sample floor prevents a single bad call from paging.
 *   2. queue_staleness — pending _queue_messages older than
 *      SLO_QUEUE_STALE_MIN (default 15) minutes. Any stale job is a breach:
 *      the queue poll loop runs every second, so a 15-minute-old pending job
 *      means the queue is stuck (poller dead, handler wedged, or poison-loop).
 *   3. sweep_lag — age of the queue-depth sampler's last recorded success
 *      (monitoring/sweep-heartbeats.ts). The sampler ticks every 15s in every
 *      role, so an age above SLO_SWEEP_LAG_MIN (default 15) minutes means the
 *      leader-sweep machinery itself is wedged or its DB access is failing.
 *      In-process registry — see sweep-heartbeats.ts for the multi-replica
 *      caveat.
 *
 * NOT shipped: voice turn-latency P95. Turn latency is not currently measured
 * anywhere in the production path (no histogram at the turn-processing seam;
 * ai/voice-quality/audio-timings.ts is the offline eval harness). Adding
 * timing to the live audio path is not an "obviously safe" change, so it is
 * deliberately omitted — see docs/runbooks/slo-alerts.md ("Not yet measured")
 * for where it would go.
 *
 * Evaluators are exported pure functions so unit tests need no DB.
 */
import type { Logger } from '../logging/logger';
import { sloBreachTotal, sloRuleValue } from '../monitoring/metrics';
import type { OperatorAlert } from '../monitoring/alert-operator';

/** Evaluation cadence — every 5 minutes (leader-locked in app.ts). */
export const SLO_MONITOR_INTERVAL_MS = 5 * 60 * 1000;

export interface SloThresholds {
  /** Minimum acceptable completion rate (0..1). Default 0.85. */
  callCompletionMin: number;
  /** Minimum ended-call sample size before the completion rule can breach. Default 5. */
  callCompletionMinSample: number;
  /** Pending queue jobs older than this many minutes are stale. Default 15. */
  queueStaleMin: number;
  /** Sweep-heartbeat age (minutes) above which the worker loop is presumed wedged. Default 15. */
  sweepLagMin: number;
}

export interface SloRuleResult {
  rule: string;
  breached: boolean;
  /** Value exported to the slo_rule_value gauge. */
  value: number;
  summary: string;
  details: Record<string, string | number>;
  severity: OperatorAlert['severity'];
}

/**
 * Rule 1 — call completion rate over the trailing window.
 * `null` when the sample floor isn't met (not enough data to judge — never
 * page off 1 bad call at 3am).
 */
export function evaluateCallCompletion(
  counts: { total: number; completedish: number },
  thresholds: Pick<SloThresholds, 'callCompletionMin' | 'callCompletionMinSample'>,
): SloRuleResult | null {
  if (counts.total < thresholds.callCompletionMinSample) return null;
  const rate = counts.completedish / counts.total;
  return {
    rule: 'call_completion_rate',
    breached: rate < thresholds.callCompletionMin,
    value: rate,
    summary: `call completion rate ${(rate * 100).toFixed(1)}% over last 60min (threshold ${(thresholds.callCompletionMin * 100).toFixed(0)}%)`,
    details: {
      completedish: counts.completedish,
      total: counts.total,
      threshold: thresholds.callCompletionMin,
    },
    severity: 'critical',
  };
}

/** Rule 2 — pending queue jobs older than the staleness window. */
export function evaluateQueueStaleness(
  staleCount: number,
  thresholds: Pick<SloThresholds, 'queueStaleMin'>,
): SloRuleResult {
  return {
    rule: 'queue_staleness',
    breached: staleCount > 0,
    value: staleCount,
    summary: `${staleCount} pending job(s) older than ${thresholds.queueStaleMin}min in _queue_messages`,
    details: { staleCount, staleMinutes: thresholds.queueStaleMin },
    severity: 'critical',
  };
}

/**
 * Rule 3 — sweep lag: age of the canary sweep's last success in this process.
 * `lastSuccessMs === undefined` (never succeeded since boot) does NOT breach —
 * a fresh boot has no history and the queue-depth sampler runs immediately,
 * so a genuinely wedged loop will surface on the next evaluation with a real
 * timestamp gap or a queue_staleness breach.
 */
export function evaluateSweepLag(
  lastSuccessMs: number | undefined,
  nowMs: number,
  thresholds: Pick<SloThresholds, 'sweepLagMin'>,
): SloRuleResult | null {
  if (lastSuccessMs === undefined) return null;
  const lagSeconds = Math.max(0, (nowMs - lastSuccessMs) / 1000);
  return {
    rule: 'sweep_lag',
    breached: lagSeconds > thresholds.sweepLagMin * 60,
    value: lagSeconds,
    summary: `queue-depth sampler last succeeded ${Math.round(lagSeconds / 60)}min ago (threshold ${thresholds.sweepLagMin}min)`,
    details: { lagSeconds: Math.round(lagSeconds), thresholdMin: thresholds.sweepLagMin },
    severity: 'warning',
  };
}

export interface SloMonitorDeps {
  /** Cross-tenant terminal call-outcome counts since `windowStart`. */
  getCallOutcomeCounts(windowStart: Date): Promise<{ total: number; completedish: number }>;
  /** Count of pending queue jobs older than `olderThanSeconds`. */
  getStalePendingCount(olderThanSeconds: number): Promise<number>;
  /** Epoch-ms of the canary sweep's last success in this process, if any. */
  getSweepLastSuccessMs(): number | undefined;
  alert(alert: OperatorAlert): Promise<void>;
  thresholds: SloThresholds;
  logger: Logger;
  now?: () => Date;
}

export interface SloMonitorRunResult {
  evaluated: string[];
  breached: string[];
}

const COMPLETION_WINDOW_MS = 60 * 60 * 1000;

/**
 * One evaluation tick. Each rule is independently failure-soft: a rule whose
 * data read throws is logged and skipped, never aborting the other rules.
 */
export async function runSloMonitor(deps: SloMonitorDeps): Promise<SloMonitorRunResult> {
  const now = deps.now ?? (() => new Date());
  const nowMs = now().getTime();
  const results: SloRuleResult[] = [];
  const evaluated: string[] = [];

  // Rule 1 — call completion rate (last 60 min).
  try {
    const counts = await deps.getCallOutcomeCounts(new Date(nowMs - COMPLETION_WINDOW_MS));
    const r = evaluateCallCompletion(counts, deps.thresholds);
    if (r) results.push(r);
    evaluated.push('call_completion_rate');
  } catch (err) {
    deps.logger.error('SLO monitor: call-completion read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Rule 2 — queue staleness.
  try {
    const stale = await deps.getStalePendingCount(deps.thresholds.queueStaleMin * 60);
    results.push(evaluateQueueStaleness(stale, deps.thresholds));
    evaluated.push('queue_staleness');
  } catch (err) {
    deps.logger.error('SLO monitor: queue-staleness read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Rule 3 — sweep lag (in-process heartbeat; cannot throw).
  {
    const r = evaluateSweepLag(deps.getSweepLastSuccessMs(), nowMs, deps.thresholds);
    if (r) results.push(r);
    evaluated.push('sweep_lag');
  }

  const breached: string[] = [];
  for (const r of results) {
    sloRuleValue.set({ rule: r.rule }, r.value);
    if (!r.breached) continue;
    breached.push(r.rule);
    sloBreachTotal.inc({ rule: r.rule });
    // alertOperator handles its own cooldown + never throws.
    await deps.alert({
      severity: r.severity,
      rule: r.rule,
      summary: r.summary,
      details: r.details,
    });
  }

  if (breached.length > 0) {
    deps.logger.warn('SLO monitor: breaches detected', { breached });
  }
  return { evaluated, breached };
}
