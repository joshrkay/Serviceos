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
 *   4. voice_turn_latency_p95 (WS26) — P95 of `voice_turn_latency_ms` (the
 *      media-streams STT-final → first-TTS-chunk seam). Breach above
 *      SLO_TURN_LATENCY_P95_MS (default 3500) once at least
 *      SLO_TURN_LATENCY_MIN_SAMPLE (default 30) turns are recorded. CROSS-
 *      PROCESS CAVEAT: prom-client histograms are in-process, so this rule is
 *      only evaluable where the voice service runs. It is therefore gated to
 *      PROCESS_ROLE=all (single-service deploys, where the monitor and voice
 *      share a process); in split (web|voice + worker) topologies the worker
 *      that runs the monitor has no turn-latency data, so the rule is SKIPPED
 *      and the authoritative alert is a Prometheus/Grafana rule over the
 *      exported buckets — see docs/runbooks/slo-alerts.md. The in-process value
 *      is also cumulative-since-boot (histograms never reset), so this guard is
 *      a coarse backstop, not a trailing-window signal.
 *   5. voice_graded_pass_rate_7d (#1602) — share of PRODUCTION calls graded
 *      by the nightly voice-quality worker (voice_session_grades, cross-
 *      tenant) in the trailing 7 days that passed every graded criterion.
 *      Breach below SLO_VOICE_GRADED_PASS_MIN (default 0.85 — the Layer 2
 *      launch gate) once at least SLO_VOICE_GRADED_MIN_SAMPLE (default 10)
 *      calls were graded in the window. Warning severity: a quality drop is
 *      not an outage, but it is the only production signal that calls are
 *      going well, so it pages the same way the others do.
 *
 *   6. voice_reply_gap_p95 (voice parity U1, D-043) — P95 of
 *      `voice_reply_gap_ms{anchor="last_word"}`: the caller's LAST WORD → the
 *      first real reply frame Twilio acked. Breach above SLO_REPLY_GAP_P95_MS
 *      (default 1500) once SLO_REPLY_GAP_MIN_SAMPLE (default 30) last-word-
 *      anchored replies are recorded; `anchor="stt_final"` fallbacks are never
 *      mixed in. Same in-process caveat and PROCESS_ROLE=all gate as rule 4.
 *      Runs beside rule 4 for seven days; rule 4 retires once this one has
 *      held (docs/runbooks/slo-alerts.md).
 *   7. voice_reply_unacked_rate (U1, D-043) — replies whose first real frame
 *      was enqueued but never acked (`voice_reply_unacked_total`) over all
 *      replies with a first real frame. Breach above SLO_REPLY_UNACKED_RATE_MAX
 *      (default 0.01) at the same sample floor. The p95 alone would look
 *      healthier as playout failures multiply, so the two are one SLO.
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
  /** WS26 — voice turn-latency P95 breach threshold in ms. Default 3500. */
  turnLatencyP95Ms: number;
  /** WS26 — minimum recorded turns before the turn-latency rule can breach. Default 30. */
  turnLatencyMinSample: number;
  /** #1602 — minimum 7-day graded pass rate (0..1). Default 0.85 (the Layer 2 gate). */
  gradedPassRateMin: number;
  /** #1602 — minimum graded calls in the window before the rule can breach. Default 10. */
  gradedPassRateMinSample: number;
  /** U1 — reply-gap (last word → first acked real frame) P95 breach threshold in ms. Default 1500. */
  replyGapP95Ms: number;
  /** U1 — maximum share of replies that never played (0..1). Default 0.01. */
  replyUnackedRateMax: number;
  /** U1 — minimum recorded replies before either reply-gap rule can breach. Default 30. */
  replyGapMinSample: number;
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

/** Turn-latency snapshot read from the in-process histogram. */
export interface TurnLatencySnapshot {
  /** Estimated P95 in ms (Prometheus-style linear interpolation within the bucket). */
  p95Ms: number;
  /** Total recorded turns (histogram _count) — drives the sample floor. */
  sampleCount: number;
}

/** One prom-client histogram export sample (shape of `histogram.get().values[i]`). */
export interface HistogramSampleValue {
  metricName?: string;
  labels: Record<string, string | number | undefined>;
  value: number;
}

/**
 * WS26 — estimate a quantile (default P95) from a prom-client histogram's
 * exported samples, using the same linear-interpolation-within-the-bucket
 * method as Prometheus `histogram_quantile`. Pure so the SLO test can drive it
 * off a hand-built bucket set with no registry.
 *
 * `values` is `(await histogram.get()).values`: a set of cumulative
 * `*_bucket{le=...}` samples (including `le="+Inf"`) plus `*_sum` / `*_count`.
 * When the quantile falls in the open-ended `+Inf` bucket we return the largest
 * finite bucket boundary (Prometheus does the same — the true value is unknown,
 * only known to exceed that boundary).
 */
export function estimateTurnLatencyP95(
  values: ReadonlyArray<HistogramSampleValue>,
  quantile = 0.95,
): TurnLatencySnapshot {
  const finiteBuckets: Array<{ le: number; cum: number }> = [];
  let count = 0;
  for (const v of values) {
    const name = v.metricName ?? '';
    if (name.endsWith('_bucket')) {
      const le = v.labels.le;
      // The open-ended +Inf bucket carries the total but no upper bound — its
      // cumulative count equals `_count`, so nothing is lost by skipping it.
      if (le === '+Inf' || le === Infinity || le === 'Inf') continue;
      const leNum = Number(le);
      if (Number.isFinite(leNum)) finiteBuckets.push({ le: leNum, cum: v.value });
    } else if (name.endsWith('_count')) {
      count = v.value;
    }
  }
  if (count <= 0 || finiteBuckets.length === 0) {
    return { p95Ms: 0, sampleCount: Math.max(0, count) };
  }
  finiteBuckets.sort((a, b) => a.le - b.le);
  const largestFiniteLe = finiteBuckets[finiteBuckets.length - 1]!.le;
  const rank = quantile * count;
  let prevLe = 0;
  let prevCum = 0;
  for (const b of finiteBuckets) {
    if (b.cum >= rank) {
      const bucketCount = b.cum - prevCum;
      if (bucketCount <= 0) return { p95Ms: b.le, sampleCount: count };
      const p = prevLe + (b.le - prevLe) * ((rank - prevCum) / bucketCount);
      return { p95Ms: p, sampleCount: count };
    }
    prevLe = b.le;
    prevCum = b.cum;
  }
  // Quantile falls beyond the largest finite bucket (in the +Inf tail): the
  // value is only known to exceed the largest finite boundary.
  return { p95Ms: largestFiniteLe, sampleCount: count };
}

/**
 * Rule 4 (WS26) — voice turn-latency P95. `null` when there is no snapshot
 * (the monitor is not co-located with the voice service — see the role guard in
 * runSloMonitor) or the sample floor isn't met (not enough turns to judge).
 */
export function evaluateTurnLatency(
  snapshot: TurnLatencySnapshot | null,
  thresholds: Pick<SloThresholds, 'turnLatencyP95Ms' | 'turnLatencyMinSample'>,
): SloRuleResult | null {
  if (!snapshot) return null;
  if (snapshot.sampleCount < thresholds.turnLatencyMinSample) return null;
  return {
    rule: 'voice_turn_latency_p95',
    breached: snapshot.p95Ms > thresholds.turnLatencyP95Ms,
    value: snapshot.p95Ms,
    summary: `voice turn latency P95 ${Math.round(snapshot.p95Ms)}ms over ${snapshot.sampleCount} turns (threshold ${thresholds.turnLatencyP95Ms}ms)`,
    details: {
      p95Ms: Math.round(snapshot.p95Ms),
      sampleCount: snapshot.sampleCount,
      thresholdMs: thresholds.turnLatencyP95Ms,
    },
    severity: 'warning',
  };
}

/**
 * U1 — reply-gap snapshot read from the in-process `voice_reply_gap_ms` and
 * `voice_reply_unacked_total` metrics.
 */
export interface ReplyGapSnapshot {
  /** P95 (ms) over `anchor="last_word"` observations only. */
  p95Ms: number;
  /** `anchor="last_word"` acked replies — drives the p95 sample floor. */
  lastWordCount: number;
  /** Acked replies under every anchor — the acked half of the unacked-rate denominator. */
  ackedCount: number;
  /** Replies with a first real frame enqueued and no acked mark (all reasons). */
  unackedCount: number;
}

/**
 * U1 — build a {@link ReplyGapSnapshot} from the exported samples of the two
 * metrics. The p95 uses only the `last_word` population: an `stt_final`
 * observation is measured from a later anchor and would flatter the number.
 * The unacked rate keeps every acked reply in its denominator, whichever
 * anchor it carried, because the question there is "did the audio play".
 */
export function snapshotReplyGap(
  gapValues: ReadonlyArray<HistogramSampleValue>,
  unackedValues: ReadonlyArray<HistogramSampleValue>,
): ReplyGapSnapshot {
  const lastWord = estimateTurnLatencyP95(gapValues.filter((v) => v.labels.anchor === 'last_word'));
  let ackedCount = 0;
  for (const v of gapValues) {
    if ((v.metricName ?? '').endsWith('_count')) ackedCount += v.value;
  }
  let unackedCount = 0;
  for (const v of unackedValues) unackedCount += v.value;
  return {
    p95Ms: lastWord.p95Ms,
    lastWordCount: lastWord.sampleCount,
    ackedCount,
    unackedCount,
  };
}

/**
 * Rule 6 (U1, D-043) — reply-gap P95 from the caller's last word. `null` when
 * there is no snapshot (monitor not co-located with the voice service) or fewer
 * than the sample floor of last-word-anchored replies exist.
 */
export function evaluateReplyGap(
  snapshot: ReplyGapSnapshot | null,
  thresholds: Pick<SloThresholds, 'replyGapP95Ms' | 'replyGapMinSample'>,
): SloRuleResult | null {
  if (!snapshot) return null;
  if (snapshot.lastWordCount < thresholds.replyGapMinSample) return null;
  return {
    rule: 'voice_reply_gap_p95',
    breached: snapshot.p95Ms > thresholds.replyGapP95Ms,
    value: snapshot.p95Ms,
    summary: `voice reply gap P95 ${Math.round(snapshot.p95Ms)}ms (last word to first acked reply audio) over ${snapshot.lastWordCount} replies (threshold ${thresholds.replyGapP95Ms}ms)`,
    details: {
      p95Ms: Math.round(snapshot.p95Ms),
      sampleCount: snapshot.lastWordCount,
      thresholdMs: thresholds.replyGapP95Ms,
    },
    severity: 'warning',
  };
}

/**
 * Rule 7 (U1, D-043) — share of replies that never played. `null` below the
 * sample floor of replies that enqueued a first real frame (acked + unacked).
 */
export function evaluateReplyUnackedRate(
  snapshot: ReplyGapSnapshot | null,
  thresholds: Pick<SloThresholds, 'replyUnackedRateMax' | 'replyGapMinSample'>,
): SloRuleResult | null {
  if (!snapshot) return null;
  const total = snapshot.ackedCount + snapshot.unackedCount;
  if (total < thresholds.replyGapMinSample) return null;
  const rate = snapshot.unackedCount / total;
  return {
    rule: 'voice_reply_unacked_rate',
    breached: rate > thresholds.replyUnackedRateMax,
    value: rate,
    summary: `voice replies that never played ${(rate * 100).toFixed(1)}% (${snapshot.unackedCount}/${total}; threshold ${(thresholds.replyUnackedRateMax * 100).toFixed(1)}%)`,
    details: {
      unacked: snapshot.unackedCount,
      total,
      thresholdRate: thresholds.replyUnackedRateMax,
    },
    severity: 'warning',
  };
}

/**
 * Rule 5 (#1602) — 7-day production graded pass rate against the Layer 2 gate.
 * `null` below the sample floor: a handful of graded calls says nothing yet.
 */
export function evaluateGradedPassRate(
  counts: { total: number; passed: number },
  thresholds: Pick<SloThresholds, 'gradedPassRateMin' | 'gradedPassRateMinSample'>,
): SloRuleResult | null {
  if (counts.total < thresholds.gradedPassRateMinSample) return null;
  const rate = counts.passed / counts.total;
  return {
    rule: 'voice_graded_pass_rate_7d',
    breached: rate < thresholds.gradedPassRateMin,
    value: rate,
    summary: `voice graded pass rate ${(rate * 100).toFixed(1)}% over last 7d (${counts.passed}/${counts.total} graded calls; gate ${(thresholds.gradedPassRateMin * 100).toFixed(0)}%)`,
    details: {
      passed: counts.passed,
      total: counts.total,
      threshold: thresholds.gradedPassRateMin,
    },
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
  /**
   * WS26 — this process's role. The turn-latency rule reads an in-process
   * histogram and so is only evaluated when role is 'all' (the monitor and the
   * voice service share a process). See the role guard in runSloMonitor.
   */
  processRole: 'web' | 'worker' | 'voice' | 'all';
  /**
   * WS26 — snapshot of the in-process `voice_turn_latency_ms` histogram, or
   * `null` when unavailable. Only invoked when `processRole === 'all'`.
   */
  getTurnLatencySnapshot(): Promise<TurnLatencySnapshot | null>;
  /**
   * U1 — snapshot of the in-process `voice_reply_gap_ms` histogram and
   * `voice_reply_unacked_total` counter, or `null` when unavailable. Same role
   * gate as {@link getTurnLatencySnapshot}: only invoked when
   * `processRole === 'all'`.
   */
  getReplyGapSnapshot(): Promise<ReplyGapSnapshot | null>;
  /** #1602 — cross-tenant graded-call counts for grades recorded at/after `windowStart`. */
  getGradedPassRate(windowStart: Date): Promise<{ total: number; passed: number }>;
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
/** #1602 — the graded pass rate is a 7-day trailing window (nightly grading is sparse). */
const GRADED_PASS_RATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

  // Rule 4 (WS26) — voice turn-latency P95. In-process histogram: only
  // meaningful where the voice service runs. Guarded to PROCESS_ROLE=all
  // (single-service deploys); split topologies leave this unevaluated here and
  // alert via Prometheus/Grafana instead (see docs/runbooks/slo-alerts.md).
  if (deps.processRole === 'all') {
    try {
      const snapshot = await deps.getTurnLatencySnapshot();
      const r = evaluateTurnLatency(snapshot, deps.thresholds);
      if (r) results.push(r);
      evaluated.push('voice_turn_latency_p95');
    } catch (err) {
      deps.logger.error('SLO monitor: turn-latency read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Rules 6 + 7 (U1, D-043) — reply gap from the caller's last word, and the
  // share of replies that never played. Same in-process histogram caveat and
  // role gate as rule 4; they run beside it until rule 4 is retired.
  if (deps.processRole === 'all') {
    try {
      const snapshot = await deps.getReplyGapSnapshot();
      const gap = evaluateReplyGap(snapshot, deps.thresholds);
      if (gap) results.push(gap);
      const unacked = evaluateReplyUnackedRate(snapshot, deps.thresholds);
      if (unacked) results.push(unacked);
      evaluated.push('voice_reply_gap_p95', 'voice_reply_unacked_rate');
    } catch (err) {
      deps.logger.error('SLO monitor: reply-gap read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Rule 5 (#1602) — 7-day production graded pass rate vs the Layer 2 gate.
  try {
    const counts = await deps.getGradedPassRate(new Date(nowMs - GRADED_PASS_RATE_WINDOW_MS));
    const r = evaluateGradedPassRate(counts, deps.thresholds);
    if (r) results.push(r);
    evaluated.push('voice_graded_pass_rate_7d');
  } catch (err) {
    deps.logger.error('SLO monitor: graded pass-rate read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
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
