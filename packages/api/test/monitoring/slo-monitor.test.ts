/**
 * WS15 — platform SLO monitor: pure rule evaluators + the composed
 * runSloMonitor tick (breach → alert; no breach → silent; failure-soft reads).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  evaluateCallCompletion,
  evaluateQueueStaleness,
  evaluateSweepLag,
  runSloMonitor,
  type SloThresholds,
  type SloMonitorDeps,
} from '../../src/workers/slo-monitor';
import type { Logger } from '../../src/logging/logger';

const thresholds: SloThresholds = {
  callCompletionMin: 0.85,
  callCompletionMinSample: 5,
  queueStaleMin: 15,
  sweepLagMin: 15,
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

describe('runSloMonitor', () => {
  const buildDeps = (overrides: Partial<SloMonitorDeps> = {}): SloMonitorDeps & {
    alert: ReturnType<typeof vi.fn>;
  } => {
    const alert = vi.fn().mockResolvedValue(undefined);
    return {
      getCallOutcomeCounts: vi.fn().mockResolvedValue({ total: 20, completedish: 19 }),
      getStalePendingCount: vi.fn().mockResolvedValue(0),
      getSweepLastSuccessMs: () => Date.now() - 15_000,
      alert,
      thresholds,
      logger: noopLogger,
      ...overrides,
      // `alert` may be overridden; re-read it so the return type stays a spy.
    } as SloMonitorDeps & { alert: ReturnType<typeof vi.fn> };
  };

  it('healthy tick: evaluates all three rules and alerts nobody', async () => {
    const deps = buildDeps();
    const result = await runSloMonitor(deps);
    expect(result.evaluated).toEqual(['call_completion_rate', 'queue_staleness', 'sweep_lag']);
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
    expect(result.evaluated).toEqual(['queue_staleness', 'sweep_lag']);
    expect(result.breached).toEqual(['queue_staleness']);
    expect(deps.alert).toHaveBeenCalledTimes(1);
  });

  it('sample-floor completion result (null) is simply not evaluated as a breach', async () => {
    const deps = buildDeps({
      getCallOutcomeCounts: vi.fn().mockResolvedValue({ total: 1, completedish: 0 }),
    });
    const result = await runSloMonitor(deps);
    expect(result.breached).toEqual([]);
    expect(deps.alert).not.toHaveBeenCalled();
  });
});
