/**
 * WS15 — platform SLO monitor: pure rule evaluators + the composed
 * runSloMonitor tick (breach → alert; no breach → silent; failure-soft reads).
 */
import { describe, it, expect, vi } from 'vitest';
import { Histogram, Registry } from 'prom-client';
import {
  evaluateCallCompletion,
  evaluateQueueStaleness,
  evaluateSweepLag,
  evaluateTurnLatency,
  evaluateGradedPassRate,
  estimateTurnLatencyP95,
  runSloMonitor,
  type SloThresholds,
  type SloMonitorDeps,
  type TurnLatencySnapshot,
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
