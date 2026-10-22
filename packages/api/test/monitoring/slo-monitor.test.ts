/**
 * WS15 — platform SLO monitor: pure rule evaluators + the composed
 * runSloMonitor tick (breach → alert; no breach → silent; failure-soft reads).
 */
import { describe, it, expect, vi } from 'vitest';
import { Counter, Histogram, Registry } from 'prom-client';
import {
  evaluateCallCompletion,
  evaluateQueueStaleness,
  evaluateSweepLag,
  evaluateTurnLatency,
  evaluateGradedPassRate,
  evaluateReplyGap,
  evaluateReplyUnackedRate,
  estimateTurnLatencyP95,
  snapshotReplyGap,
  runSloMonitor,
  type SloThresholds,
  type SloMonitorDeps,
  type TurnLatencySnapshot,
  type ReplyGapSnapshot,
} from '../../src/workers/slo-monitor';
import type { Logger } from '../../src/logging/logger';

const thresholds: SloThresholds = {
  callCompletionMin: 0.85,
  callCompletionMinSample: 5,
  queueStaleMin: 15,
  sweepLagMin: 15,
  turnLatencyP95Ms: 3500,
  turnLatencyMinSample: 30,
  gradedPassRateMin: 0.85,
  gradedPassRateMinSample: 10,
  replyGapP95Ms: 1500,
  replyUnackedRateMax: 0.01,
  replyGapMinSample: 30,
};

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

describe('evaluateCallCompletion', () => {
  it('breaches below the threshold with enough samples', () => {
    const r = evaluateCallCompletion({ total: 10, completedish: 7 }, thresholds);
    expect(r).not.toBeNull();
    expect(r!.breached).toBe(true);
    expect(r!.value).toBeCloseTo(0.7);
    expect(r!.rule).toBe('call_completion_rate');
  });

  it('does not breach at/above the threshold', () => {
    const r = evaluateCallCompletion({ total: 20, completedish: 18 }, thresholds);
    expect(r!.breached).toBe(false);
    expect(r!.value).toBeCloseTo(0.9);
  });

  it('exactly at the threshold is NOT a breach (breach is strictly below)', () => {
    const r = evaluateCallCompletion({ total: 20, completedish: 17 }, thresholds);
    expect(r!.value).toBeCloseTo(0.85);
    expect(r!.breached).toBe(false);
  });

  it('sample floor: returns null below the minimum sample size (no 1-call pages)', () => {
    // 0/4 completed would be a catastrophic rate — but 4 < floor of 5.
    expect(evaluateCallCompletion({ total: 4, completedish: 0 }, thresholds)).toBeNull();
    expect(evaluateCallCompletion({ total: 0, completedish: 0 }, thresholds)).toBeNull();
  });

  it('evaluates exactly at the sample floor', () => {
    const r = evaluateCallCompletion({ total: 5, completedish: 2 }, thresholds);
    expect(r).not.toBeNull();
    expect(r!.breached).toBe(true);
  });
});

describe('evaluateQueueStaleness', () => {
  it('breaches when any pending job is stale', () => {
    const r = evaluateQueueStaleness(3, thresholds);
    expect(r.breached).toBe(true);
    expect(r.value).toBe(3);
    expect(r.rule).toBe('queue_staleness');
  });

  it('does not breach with zero stale jobs', () => {
    expect(evaluateQueueStaleness(0, thresholds).breached).toBe(false);
  });
});

describe('evaluateSweepLag', () => {
  const now = 1_000_000_000_000;

  it('breaches when the heartbeat is older than the threshold', () => {
    const r = evaluateSweepLag(now - 16 * 60 * 1000, now, thresholds);
    expect(r).not.toBeNull();
    expect(r!.breached).toBe(true);
    expect(r!.rule).toBe('sweep_lag');
    expect(r!.value).toBeCloseTo(16 * 60);
  });

  it('does not breach with a fresh heartbeat', () => {
    const r = evaluateSweepLag(now - 30 * 1000, now, thresholds);
    expect(r!.breached).toBe(false);
  });

  it('returns null when no heartbeat has been recorded yet (fresh boot)', () => {
    expect(evaluateSweepLag(undefined, now, thresholds)).toBeNull();
  });
});

/**
 * WS26 — build a real prom-client histogram from a list of observed turn
 * latencies (ms) so `estimateTurnLatencyP95` is exercised against the ACTUAL
 * `.get()` export shape, not a hand-faked one.
 */
async function snapshotFromObservations(observationsMs: number[]): Promise<TurnLatencySnapshot> {
  const reg = new Registry();
  const h = new Histogram({
    name: 'voice_turn_latency_ms',
    help: 'test',
    buckets: [250, 500, 1000, 1500, 2000, 2500, 3000, 3500, 5000, 7500, 10_000],
    registers: [reg],
  });
  for (const ms of observationsMs) h.observe(ms);
  const snap = await h.get();
  return estimateTurnLatencyP95(snap.values);
}

describe('estimateTurnLatencyP95', () => {
  it('reports zero samples for an empty histogram', async () => {
    const snap = await snapshotFromObservations([]);
    expect(snap.sampleCount).toBe(0);
    expect(snap.p95Ms).toBe(0);
  });

  it('counts every observation and estimates a P95 within the spanning bucket', async () => {
    // 100 fast turns around 300ms, so P95 sits in the low buckets.
    const snap = await snapshotFromObservations(Array.from({ length: 100 }, () => 300));
    expect(snap.sampleCount).toBe(100);
    // All in the (250,500] bucket → interpolates within [250,500].
    expect(snap.p95Ms).toBeGreaterThan(250);
    expect(snap.p95Ms).toBeLessThanOrEqual(500);
  });

  it('estimates a high P95 when the tail is slow', async () => {
    // 90 fast (500ms) + 10 slow (9000ms): P95 lands in the slow tail.
    const obs = [
      ...Array.from({ length: 90 }, () => 500),
      ...Array.from({ length: 10 }, () => 9000),
    ];
    const snap = await snapshotFromObservations(obs);
    expect(snap.sampleCount).toBe(100);
    expect(snap.p95Ms).toBeGreaterThan(3500);
  });

  it('returns the largest finite bucket bound when the quantile falls in the +Inf tail', () => {
    // One observation above the top bucket (10s): +Inf holds it, P95 clamps to 10000.
    const snap = estimateTurnLatencyP95([
      { metricName: 'voice_turn_latency_ms_bucket', labels: { le: 10_000 }, value: 0 },
      { metricName: 'voice_turn_latency_ms_bucket', labels: { le: '+Inf' }, value: 1 },
      { metricName: 'voice_turn_latency_ms_count', labels: {}, value: 1 },
    ]);
    expect(snap.sampleCount).toBe(1);
    expect(snap.p95Ms).toBe(10_000);
  });
});

describe('evaluateTurnLatency', () => {
  it('breaches when P95 exceeds the threshold with enough samples', () => {
    const r = evaluateTurnLatency({ p95Ms: 4200, sampleCount: 50 }, thresholds);
    expect(r).not.toBeNull();
    expect(r!.rule).toBe('voice_turn_latency_p95');
    expect(r!.breached).toBe(true);
    expect(r!.value).toBe(4200);
    expect(r!.severity).toBe('warning');
  });

  it('does not breach at/below the threshold', () => {
    expect(evaluateTurnLatency({ p95Ms: 3500, sampleCount: 50 }, thresholds)!.breached).toBe(false);
    expect(evaluateTurnLatency({ p95Ms: 1200, sampleCount: 50 }, thresholds)!.breached).toBe(false);
  });

  it('sample floor: returns null below the minimum sample size', () => {
    // A catastrophic 9s P95 — but only 29 turns (< floor of 30) → no page.
    expect(evaluateTurnLatency({ p95Ms: 9000, sampleCount: 29 }, thresholds)).toBeNull();
  });

  it('returns null when there is no snapshot (voice not co-located)', () => {
    expect(evaluateTurnLatency(null, thresholds)).toBeNull();
  });
});

/**
 * U1 — build the snapshot from REAL prom-client metrics (the actual `.get()`
 * export shape, labels included), not a hand-faked one.
 */
async function replyGapSnapshotFrom(opts: {
  lastWordMs?: number[];
  sttFinalMs?: number[];
  unacked?: Partial<Record<'clear_echo' | 'ack_timeout' | 'stream_closed', number>>;
}): Promise<ReplyGapSnapshot> {
  const reg = new Registry();
  const gap = new Histogram({
    name: 'voice_reply_gap_ms',
    help: 'test',
    labelNames: ['anchor'] as const,
    buckets: [250, 500, 1000, 1500, 2000, 2500, 3000, 3500, 5000, 7500, 10_000],
    registers: [reg],
  });
  const unacked = new Counter({
    name: 'voice_reply_unacked_total',
    help: 'test',
    labelNames: ['reason'] as const,
    registers: [reg],
  });
  for (const ms of opts.lastWordMs ?? []) gap.observe({ anchor: 'last_word' }, ms);
  for (const ms of opts.sttFinalMs ?? []) gap.observe({ anchor: 'stt_final' }, ms);
  for (const [reason, n] of Object.entries(opts.unacked ?? {})) {
    unacked.inc({ reason }, n);
  }
  return snapshotReplyGap((await gap.get()).values, (await unacked.get()).values);
}

describe('snapshotReplyGap / evaluateReplyGap (U1 — voice_reply_gap_p95)', () => {
  it('p95 is computed from last_word observations only; stt_final is ignored', async () => {
    // 40 healthy last-word replies, plus 100 slow stt_final fallbacks that
    // would drag the p95 well above the threshold if they were mixed in.
    const snap = await replyGapSnapshotFrom({
      lastWordMs: Array.from({ length: 40 }, () => 900),
      sttFinalMs: Array.from({ length: 100 }, () => 7000),
    });
    expect(snap.lastWordCount).toBe(40);
    expect(snap.ackedCount).toBe(140);
    expect(snap.p95Ms).toBeLessThanOrEqual(1000);
    const r = evaluateReplyGap(snap, thresholds)!;
    expect(r.breached).toBe(false);
  });

  it('stays silent below the min sample, even when the p95 is terrible', async () => {
    const snap = await replyGapSnapshotFrom({ lastWordMs: Array.from({ length: 29 }, () => 6000) });
    expect(evaluateReplyGap(snap, thresholds)).toBeNull();
  });

  it('stt_final observations do not count toward the last-word sample floor', async () => {
    const snap = await replyGapSnapshotFrom({
      lastWordMs: Array.from({ length: 10 }, () => 6000),
      sttFinalMs: Array.from({ length: 100 }, () => 6000),
    });
    expect(evaluateReplyGap(snap, thresholds)).toBeNull();
  });

  it('warns with the measured p95 once above threshold at the sample floor', async () => {
    const snap = await replyGapSnapshotFrom({ lastWordMs: Array.from({ length: 30 }, () => 2200) });
    const r = evaluateReplyGap(snap, thresholds)!;
    expect(r.rule).toBe('voice_reply_gap_p95');
    expect(r.breached).toBe(true);
    expect(r.severity).toBe('warning');
    expect(r.value).toBeGreaterThan(1500);
    expect(r.details).toMatchObject({
      p95Ms: Math.round(snap.p95Ms),
      sampleCount: 30,
      thresholdMs: 1500,
    });
    expect(r.summary).toContain(`${Math.round(snap.p95Ms)}ms`);
  });

  it('does not breach exactly at the threshold, and null snapshot is not evaluated', () => {
    const at: ReplyGapSnapshot = { p95Ms: 1500, lastWordCount: 50, ackedCount: 50, unackedCount: 0 };
    expect(evaluateReplyGap(at, thresholds)!.breached).toBe(false);
    expect(evaluateReplyGap(null, thresholds)).toBeNull();
  });

  it('an empty metric set yields a zeroed snapshot', async () => {
    const snap = await replyGapSnapshotFrom({});
    expect(snap).toEqual({ p95Ms: 0, lastWordCount: 0, ackedCount: 0, unackedCount: 0 });
  });
});

describe('evaluateReplyUnackedRate (U1 — voice_reply_unacked_rate)', () => {
  it('sums unacked across reasons and warns above 1 %', async () => {
    const snap = await replyGapSnapshotFrom({
      lastWordMs: Array.from({ length: 96 }, () => 800),
      unacked: { clear_echo: 1, ack_timeout: 2, stream_closed: 1 },
    });
    expect(snap.unackedCount).toBe(4);
    const r = evaluateReplyUnackedRate(snap, thresholds)!;
    expect(r.rule).toBe('voice_reply_unacked_rate');
    expect(r.breached).toBe(true);
    expect(r.severity).toBe('warning');
    expect(r.value).toBeCloseTo(0.04, 5);
    expect(r.details).toMatchObject({ unacked: 4, total: 100, thresholdRate: 0.01 });
  });

  it('counts stt_final-anchored acked replies in the denominator', async () => {
    const snap = await replyGapSnapshotFrom({
      lastWordMs: Array.from({ length: 50 }, () => 800),
      sttFinalMs: Array.from({ length: 50 }, () => 800),
      unacked: { ack_timeout: 1 },
    });
    // 1 / 101 is under 1 %.
    const r = evaluateReplyUnackedRate(snap, thresholds)!;
    expect(r.breached).toBe(false);
    expect(r.details).toMatchObject({ unacked: 1, total: 101 });
  });

  it('stays silent below the min sample of replies that enqueued a real frame', () => {
    const snap: ReplyGapSnapshot = { p95Ms: 0, lastWordCount: 0, ackedCount: 20, unackedCount: 9 };
    expect(evaluateReplyUnackedRate(snap, thresholds)).toBeNull();
    expect(evaluateReplyUnackedRate(null, thresholds)).toBeNull();
  });

  it('does not breach exactly at the maximum rate', () => {
    const snap: ReplyGapSnapshot = { p95Ms: 0, lastWordCount: 99, ackedCount: 99, unackedCount: 1 };
    expect(evaluateReplyUnackedRate(snap, thresholds)!.breached).toBe(false);
  });
});

describe('evaluateGradedPassRate (#1602 — 7-day production graded pass rate vs the Layer 2 gate)', () => {
  it('breaches when fewer than 85% of graded calls passed, with enough graded calls', () => {
    const r = evaluateGradedPassRate({ total: 20, passed: 16 }, thresholds);
    expect(r).not.toBeNull();
    expect(r!.rule).toBe('voice_graded_pass_rate_7d');
    expect(r!.breached).toBe(true);
    expect(r!.value).toBeCloseTo(0.8);
    expect(r!.severity).toBe('warning');
    expect(r!.details).toEqual({ passed: 16, total: 20, threshold: 0.85 });
  });

  it('does not breach at the gate (85% passes the gate)', () => {
    const r = evaluateGradedPassRate({ total: 20, passed: 17 }, thresholds);
    expect(r!.breached).toBe(false);
  });

  it('sample floor: fewer than 10 graded calls in the window is not judged', () => {
    expect(evaluateGradedPassRate({ total: 9, passed: 0 }, thresholds)).toBeNull();
    expect(evaluateGradedPassRate({ total: 0, passed: 0 }, thresholds)).toBeNull();
  });
});

describe('runSloMonitor', () => {
  const buildDeps = (overrides: Partial<SloMonitorDeps> = {}): SloMonitorDeps & {
    alert: ReturnType<typeof vi.fn>;
  } => {
    const alert = vi.fn().mockResolvedValue(undefined);
    return {
      getCallOutcomeCounts: vi.fn().mockResolvedValue({ total: 20, completedish: 19 }),
      getStalePendingCount: vi.fn().mockResolvedValue(0),
      getSweepLastSuccessMs: () => Date.now() - 15_000,
      processRole: 'worker',
      getTurnLatencySnapshot: vi.fn().mockResolvedValue(null),
      getReplyGapSnapshot: vi.fn().mockResolvedValue(null),
      getGradedPassRate: vi.fn().mockResolvedValue({ total: 0, passed: 0 }),
      alert,
      thresholds,
      logger: noopLogger,
      ...overrides,
      // `alert` may be overridden; re-read it so the return type stays a spy.
    } as SloMonitorDeps & { alert: ReturnType<typeof vi.fn> };
  };

  it('healthy tick: evaluates every always-on rule and alerts nobody', async () => {
    const deps = buildDeps();
    const result = await runSloMonitor(deps);
    expect(result.evaluated).toEqual([
      'call_completion_rate',
      'queue_staleness',
      'sweep_lag',
      'voice_graded_pass_rate_7d',
    ]);
    expect(result.breached).toEqual([]);
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it('breach tick: pages once per breached rule with rule/summary/details', async () => {
    const deps = buildDeps({
      getCallOutcomeCounts: vi.fn().mockResolvedValue({ total: 10, completedish: 5 }),
      getStalePendingCount: vi.fn().mockResolvedValue(7),
    });
    const result = await runSloMonitor(deps);
    expect(result.breached).toEqual(['call_completion_rate', 'queue_staleness']);
    expect(deps.alert).toHaveBeenCalledTimes(2);
    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({ rule: 'call_completion_rate', severity: 'critical' }),
    );
    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: 'queue_staleness',
        details: expect.objectContaining({ staleCount: 7 }),
      }),
    );
  });

  it('passes a 60-minute window start to the completion read', async () => {
    const nowDate = new Date('2026-07-11T12:00:00Z');
    const getCallOutcomeCounts = vi.fn().mockResolvedValue({ total: 0, completedish: 0 });
    await runSloMonitor(buildDeps({ getCallOutcomeCounts, now: () => nowDate }));
    expect(getCallOutcomeCounts).toHaveBeenCalledWith(new Date('2026-07-11T11:00:00Z'));
  });

  it('is failure-soft: one rule read throwing does not abort the other rules', async () => {
    const deps = buildDeps({
      getCallOutcomeCounts: vi.fn().mockRejectedValue(new Error('db down')),
      getStalePendingCount: vi.fn().mockResolvedValue(2),
    });
    const result = await runSloMonitor(deps);
    // Completion rule skipped, staleness still evaluated + breached.
    expect(result.evaluated).toEqual(['queue_staleness', 'sweep_lag', 'voice_graded_pass_rate_7d']);
    expect(result.breached).toEqual(['queue_staleness']);
    expect(deps.alert).toHaveBeenCalledTimes(1);
  });

  it('#1602: a 7-day graded pass rate under the gate pages the operator, read over a 7-day window', async () => {
    const nowDate = new Date('2026-10-05T08:00:00Z');
    const getGradedPassRate = vi.fn().mockResolvedValue({ total: 12, passed: 9 });
    const deps = buildDeps({
      getGradedPassRate,
      now: () => nowDate,
      // Keep the sweep heartbeat fresh relative to the injected clock.
      getSweepLastSuccessMs: () => nowDate.getTime() - 15_000,
    });
    const result = await runSloMonitor(deps);
    expect(getGradedPassRate).toHaveBeenCalledWith(new Date('2026-09-28T08:00:00Z'));
    expect(result.breached).toEqual(['voice_graded_pass_rate_7d']);
    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: 'voice_graded_pass_rate_7d',
        severity: 'warning',
        details: expect.objectContaining({ passed: 9, total: 12 }),
      }),
    );
  });

  it('sample-floor completion result (null) is simply not evaluated as a breach', async () => {
    const deps = buildDeps({
      getCallOutcomeCounts: vi.fn().mockResolvedValue({ total: 1, completedish: 0 }),
    });
    const result = await runSloMonitor(deps);
    expect(result.breached).toEqual([]);
    expect(deps.alert).not.toHaveBeenCalled();
  });

  // ── U1 — reply-gap rules (D-043), same in-process role gate as rule 4 ──────
  it('U1 role guard: reply-gap rules are not evaluated or read in a non-all role', async () => {
    const getReplyGapSnapshot = vi
      .fn()
      .mockResolvedValue({ p95Ms: 9000, lastWordCount: 100, ackedCount: 100, unackedCount: 50 });
    const result = await runSloMonitor(buildDeps({ processRole: 'worker', getReplyGapSnapshot }));
    expect(result.evaluated).not.toContain('voice_reply_gap_p95');
    expect(result.evaluated).not.toContain('voice_reply_unacked_rate');
    expect(getReplyGapSnapshot).not.toHaveBeenCalled();
  });

  it('U1: under PROCESS_ROLE=all both reply-gap rules page beside the untouched turn-latency rule', async () => {
    const deps = buildDeps({
      processRole: 'all',
      getTurnLatencySnapshot: vi.fn().mockResolvedValue({ p95Ms: 1200, sampleCount: 100 }),
      getReplyGapSnapshot: vi
        .fn()
        .mockResolvedValue({ p95Ms: 2600, lastWordCount: 100, ackedCount: 100, unackedCount: 5 }),
    });
    const result = await runSloMonitor(deps);
    expect(result.evaluated).toEqual(
      expect.arrayContaining([
        'voice_turn_latency_p95',
        'voice_reply_gap_p95',
        'voice_reply_unacked_rate',
      ]),
    );
    expect(result.breached).toEqual(['voice_reply_gap_p95', 'voice_reply_unacked_rate']);
    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({ rule: 'voice_reply_gap_p95', severity: 'warning' }),
    );
  });

  it('U1: a failing reply-gap read is logged and does not abort later rules', async () => {
    const deps = buildDeps({
      processRole: 'all',
      getReplyGapSnapshot: vi.fn().mockRejectedValue(new Error('prom down')),
    });
    const result = await runSloMonitor(deps);
    expect(result.evaluated).toContain('voice_graded_pass_rate_7d');
    expect(result.evaluated).not.toContain('voice_reply_gap_p95');
  });

  // ── WS26 — voice turn-latency rule + its cross-process role guard ──────────
  it('role guard: does NOT evaluate turn latency in a non-all role (split topology)', async () => {
    const getTurnLatencySnapshot = vi.fn().mockResolvedValue({ p95Ms: 9000, sampleCount: 100 });
    const deps = buildDeps({ processRole: 'worker', getTurnLatencySnapshot });
    const result = await runSloMonitor(deps);
    // A 9s P95 would breach — but the worker has no in-process voice histogram,
    // so the rule is skipped entirely and the snapshot is never even read.
    expect(result.evaluated).not.toContain('voice_turn_latency_p95');
    expect(result.breached).not.toContain('voice_turn_latency_p95');
    expect(getTurnLatencySnapshot).not.toHaveBeenCalled();
  });

  it('evaluates and breaches turn latency under PROCESS_ROLE=all', async () => {
    const deps = buildDeps({
      processRole: 'all',
      getTurnLatencySnapshot: vi.fn().mockResolvedValue({ p95Ms: 9000, sampleCount: 100 }),
    });
    const result = await runSloMonitor(deps);
    expect(result.evaluated).toContain('voice_turn_latency_p95');
    expect(result.breached).toContain('voice_turn_latency_p95');
    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({ rule: 'voice_turn_latency_p95', severity: 'warning' }),
    );
  });

  it('under role=all with a healthy P95, evaluates the rule but pages nobody', async () => {
    const deps = buildDeps({
      processRole: 'all',
      getTurnLatencySnapshot: vi.fn().mockResolvedValue({ p95Ms: 1200, sampleCount: 100 }),
    });
    const result = await runSloMonitor(deps);
    expect(result.evaluated).toContain('voice_turn_latency_p95');
    expect(result.breached).toEqual([]);
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it('under role=all below the sample floor, the rule is attempted but not breached', async () => {
    const deps = buildDeps({
      processRole: 'all',
      getTurnLatencySnapshot: vi.fn().mockResolvedValue({ p95Ms: 9000, sampleCount: 5 }),
    });
    const result = await runSloMonitor(deps);
    expect(result.evaluated).toContain('voice_turn_latency_p95');
    expect(result.breached).toEqual([]);
  });

  it('is failure-soft: a throwing turn-latency read does not abort the tick', async () => {
    const deps = buildDeps({
      processRole: 'all',
      getTurnLatencySnapshot: vi.fn().mockRejectedValue(new Error('registry boom')),
      getStalePendingCount: vi.fn().mockResolvedValue(3),
    });
    const result = await runSloMonitor(deps);
    // Turn-latency skipped, the other rules still evaluated + the stale breach fires.
    expect(result.evaluated).not.toContain('voice_turn_latency_p95');
    expect(result.breached).toContain('queue_staleness');
  });
});
