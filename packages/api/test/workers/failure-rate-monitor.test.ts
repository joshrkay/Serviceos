/**
 * FAIL-VIS — silent-failure monitor: pure rule evaluators, the composed
 * runFailureRateMonitor tick, the alertOperator suppression seam, and the
 * "this check cannot itself cause an incident" guarantees.
 *
 * The fixtures use the REAL production numbers from the 2026-07 investigation
 * so the tests double as a regression record: supervisor_annotate's 13,682
 * runs with zero completions, and classify_intent's 1,325-of-1,563 failures.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  evaluateTaskFailureRate,
  evaluateStalledExecutions,
  evaluateSilentExecutionFailures,
  runFailureRateMonitor,
  FAILURE_MONITOR_INTERVAL_MS,
  type FailureMonitorThresholds,
  type FailureRateMonitorDeps,
  type ProposalExecutionCounts,
  type TaskRunCounts,
} from '../../src/workers/failure-rate-monitor';
import { createAlertOperator } from '../../src/monitoring/alert-operator';
import type { Logger } from '../../src/logging/logger';

const thresholds: FailureMonitorThresholds = {
  windowMin: 30,
  settleMin: 5,
  rateMax: 0.25,
  minRuns: 20,
  maxTaskAlerts: 3,
  proposalStaleMin: 15,
  proposalLookbackHours: 24,
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

function counts(over: Partial<TaskRunCounts>): TaskRunCounts {
  return { taskType: 'classify_intent', total: 0, completed: 0, failed: 0, unresolved: 0, ...over };
}

const healthyProposals: ProposalExecutionCounts = {
  stalledExecuting: 0,
  failedWithoutError: 0,
  stalledSampleIds: [],
  failedSampleIds: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1 — per-task non-completion rate
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateTaskFailureRate', () => {
  it('fires above the threshold at volume (classify_intent, 23 July: 1325/1563 failed)', () => {
    const r = evaluateTaskFailureRate(
      counts({ taskType: 'classify_intent', total: 1563, completed: 238, failed: 1325 }),
      thresholds,
    );
    expect(r).not.toBeNull();
    expect(r!.breached).toBe(true);
    expect(r!.rule).toBe('ai_task_failure_rate:classify_intent');
    expect(r!.value).toBeCloseTo(1325 / 1563, 4);
    expect(r!.severity).toBe('critical');
  });

  it('fires on the supervisor_annotate shape: high volume, ZERO completions, zero "failed"', () => {
    // The runs never terminated at all — a plain failed/total ratio would be
    // 0.00 and this storm would stay invisible. Non-completion catches it.
    const r = evaluateTaskFailureRate(
      counts({ taskType: 'supervisor_annotate', total: 285, completed: 0, failed: 0, unresolved: 285 }),
      thresholds,
    );
    expect(r!.breached).toBe(true);
    expect(r!.value).toBe(1);
    expect(r!.summary).toContain('ZERO completions');
    expect(r!.details.unresolved).toBe(285);
    expect(r!.details.failed).toBe(0);
  });

  it('stays quiet below the volume floor even at a 100% failure rate', () => {
    // 1 failure in 2 calls is noise. The floor is checked BEFORE the rate, so
    // a catastrophic-looking ratio on a tiny denominator never reaches alerting.
    expect(
      evaluateTaskFailureRate(counts({ total: 2, completed: 0, failed: 2 }), thresholds),
    ).toBeNull();
    expect(
      evaluateTaskFailureRate(counts({ total: 19, completed: 0, failed: 19 }), thresholds),
    ).toBeNull();
    expect(evaluateTaskFailureRate(counts({ total: 0 }), thresholds)).toBeNull();
  });

  it('evaluates exactly at the volume floor', () => {
    const r = evaluateTaskFailureRate(
      counts({ total: 20, completed: 0, failed: 20 }),
      thresholds,
    );
    expect(r).not.toBeNull();
    expect(r!.breached).toBe(true);
  });

  it('does not fire at or below the threshold (breach is strictly above)', () => {
    const atThreshold = evaluateTaskFailureRate(
      counts({ total: 100, completed: 75, failed: 25 }),
      thresholds,
    );
    expect(atThreshold!.value).toBeCloseTo(0.25);
    expect(atThreshold!.breached).toBe(false);

    const healthy = evaluateTaskFailureRate(
      counts({ total: 500, completed: 498, failed: 2 }),
      thresholds,
    );
    expect(healthy!.breached).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules 2 + 3 — silent proposal-execution failures
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateStalledExecutions', () => {
  it('fires on any proposal stuck in executing past the bound', () => {
    const r = evaluateStalledExecutions(
      { stalledExecuting: 4, stalledSampleIds: ['p1', 'p2'] },
      thresholds,
    );
    expect(r.breached).toBe(true);
    expect(r.rule).toBe('proposal_execution_stalled');
    expect(r.details.sampleIds).toBe('p1,p2');
  });

  it('is quiet with none stalled', () => {
    expect(
      evaluateStalledExecutions({ stalledExecuting: 0, stalledSampleIds: [] }, thresholds).breached,
    ).toBe(false);
  });
});

describe('evaluateSilentExecutionFailures', () => {
  it('catches a single execution_failed proposal with a NULL execution_error', () => {
    // The exact signature that hid the estimate bug for weeks: a terminal
    // failure state carrying no reason. One is enough.
    const r = evaluateSilentExecutionFailures(
      { failedWithoutError: 1, failedSampleIds: ['prop-estimate-1'] },
      thresholds,
    );
    expect(r.breached).toBe(true);
    expect(r.rule).toBe('proposal_execution_failed_silently');
    expect(r.value).toBe(1);
    expect(r.details.sampleIds).toBe('prop-estimate-1');
    expect(r.summary).toContain('NULL execution_error');
  });

  it('is quiet when every terminal failure carries a reason', () => {
    expect(
      evaluateSilentExecutionFailures(
        { failedWithoutError: 0, failedSampleIds: [] },
        thresholds,
      ).breached,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Composed tick
// ─────────────────────────────────────────────────────────────────────────────
describe('runFailureRateMonitor', () => {
  const buildDeps = (
    overrides: Partial<FailureRateMonitorDeps> = {},
  ): FailureRateMonitorDeps & { alert: ReturnType<typeof vi.fn> } => {
    return {
      getTaskRunCounts: vi.fn().mockResolvedValue([]),
      getProposalExecutionCounts: vi.fn().mockResolvedValue(healthyProposals),
      alert: vi.fn().mockResolvedValue(undefined),
      thresholds,
      logger: noopLogger,
      ...overrides,
    } as FailureRateMonitorDeps & { alert: ReturnType<typeof vi.fn> };
  };

  it('healthy tick: evaluates every rule and alerts nobody', async () => {
    const deps = buildDeps({
      getTaskRunCounts: vi
        .fn()
        .mockResolvedValue([counts({ total: 400, completed: 399, failed: 1 })]),
    });
    const result = await runFailureRateMonitor(deps);
    expect(result.evaluated).toEqual([
      'ai_task_failure_rate',
      'proposal_execution_stalled',
      'proposal_execution_failed_silently',
    ]);
    expect(result.breached).toEqual([]);
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it('fires above threshold: pages once per breached rule', async () => {
    const deps = buildDeps({
      getTaskRunCounts: vi.fn().mockResolvedValue([
        counts({ taskType: 'supervisor_annotate', total: 285, completed: 0, unresolved: 285 }),
        counts({ taskType: 'classify_intent', total: 1563, completed: 238, failed: 1325 }),
      ]),
      getProposalExecutionCounts: vi.fn().mockResolvedValue({
        stalledExecuting: 0,
        failedWithoutError: 3,
        stalledSampleIds: [],
        failedSampleIds: ['a', 'b', 'c'],
      }),
    });
    const result = await runFailureRateMonitor(deps);
    expect(result.breached).toEqual([
      'ai_task_failure_rate:supervisor_annotate',
      'ai_task_failure_rate:classify_intent',
      'proposal_execution_failed_silently',
    ]);
    expect(deps.alert).toHaveBeenCalledTimes(3);
    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: 'ai_task_failure_rate:supervisor_annotate',
        severity: 'critical',
      }),
    );
    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: 'proposal_execution_failed_silently',
        details: expect.objectContaining({ silentFailures: 3 }),
      }),
    );
  });

  it('stays quiet below the volume floor: a 100%-failing low-volume task pages nobody', async () => {
    const deps = buildDeps({
      getTaskRunCounts: vi
        .fn()
        .mockResolvedValue([counts({ taskType: 'draft_estimate', total: 2, completed: 0, failed: 2 })]),
    });
    const result = await runFailureRateMonitor(deps);
    expect(result.breached).toEqual([]);
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it('offsets the window by the settle bound so in-flight runs are not counted as failures', async () => {
    const getTaskRunCounts = vi.fn().mockResolvedValue([]);
    await runFailureRateMonitor(
      buildDeps({ getTaskRunCounts, now: () => new Date('2026-07-24T12:00:00Z') }),
    );
    // windowEnd = now - 5min settle; windowStart = windowEnd - 30min window.
    expect(getTaskRunCounts).toHaveBeenCalledWith(
      new Date('2026-07-24T11:25:00Z'),
      new Date('2026-07-24T11:55:00Z'),
    );
  });

  it('passes the staleness and lookback bounds to the proposal read', async () => {
    const getProposalExecutionCounts = vi.fn().mockResolvedValue(healthyProposals);
    await runFailureRateMonitor(
      buildDeps({ getProposalExecutionCounts, now: () => new Date('2026-07-24T12:00:00Z') }),
    );
    expect(getProposalExecutionCounts).toHaveBeenCalledWith(
      new Date('2026-07-24T11:45:00Z'),
      new Date('2026-07-23T12:00:00Z'),
    );
  });

  it('caps task-failure pages per tick (worst first) so it cannot become its own storm', async () => {
    const rows = ['t1', 't2', 't3', 't4', 't5'].map((taskType, i) =>
      counts({ taskType, total: 100, completed: i, failed: 100 - i }),
    );
    const deps = buildDeps({ getTaskRunCounts: vi.fn().mockResolvedValue(rows) });
    const result = await runFailureRateMonitor(deps);
    // 5 task types breach; only maxTaskAlerts=3 page, worst rate first.
    expect(deps.alert).toHaveBeenCalledTimes(3);
    expect(result.suppressedByCap).toEqual([
      'ai_task_failure_rate:t4',
      'ai_task_failure_rate:t5',
    ]);
    // Everything breached is still reported (the cap limits paging, not visibility).
    expect(result.breached).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "This check cannot itself cause an incident"
// ─────────────────────────────────────────────────────────────────────────────
describe('runFailureRateMonitor — failure containment', () => {
  const buildDeps = (
    overrides: Partial<FailureRateMonitorDeps> = {},
  ): FailureRateMonitorDeps & { alert: ReturnType<typeof vi.fn> } =>
    ({
      getTaskRunCounts: vi.fn().mockResolvedValue([]),
      getProposalExecutionCounts: vi.fn().mockResolvedValue(healthyProposals),
      alert: vi.fn().mockResolvedValue(undefined),
      thresholds,
      logger: noopLogger,
      ...overrides,
    }) as FailureRateMonitorDeps & { alert: ReturnType<typeof vi.fn> };

  it('a thrown error inside the check does not escape', async () => {
    const deps = buildDeps({
      getTaskRunCounts: vi.fn().mockRejectedValue(new Error('db down')),
      getProposalExecutionCounts: vi.fn().mockRejectedValue(new Error('db down')),
    });
    // Resolves, does not reject.
    await expect(runFailureRateMonitor(deps)).resolves.toEqual({
      evaluated: [],
      breached: [],
      suppressedByCap: [],
    });
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it('is failure-soft per rule: one read throwing does not abort the others', async () => {
    const deps = buildDeps({
      getTaskRunCounts: vi.fn().mockRejectedValue(new Error('ai_runs read exploded')),
      getProposalExecutionCounts: vi.fn().mockResolvedValue({
        stalledExecuting: 2,
        failedWithoutError: 0,
        stalledSampleIds: ['p9'],
        failedSampleIds: [],
      }),
    });
    const result = await runFailureRateMonitor(deps);
    expect(result.evaluated).toEqual([
      'proposal_execution_stalled',
      'proposal_execution_failed_silently',
    ]);
    expect(result.breached).toEqual(['proposal_execution_stalled']);
    expect(deps.alert).toHaveBeenCalledTimes(1);
  });

  it('a throwing alert channel does not abort the remaining pages or the tick', async () => {
    const alert = vi
      .fn()
      .mockRejectedValueOnce(new Error('pager offline'))
      .mockResolvedValue(undefined);
    const deps = buildDeps({
      alert,
      getTaskRunCounts: vi
        .fn()
        .mockResolvedValue([counts({ total: 100, completed: 0, failed: 100 })]),
      getProposalExecutionCounts: vi.fn().mockResolvedValue({
        stalledExecuting: 1,
        failedWithoutError: 0,
        stalledSampleIds: ['p1'],
        failedSampleIds: [],
      }),
    });
    await expect(runFailureRateMonitor(deps)).resolves.toBeDefined();
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('a throwing logger cannot escape either', async () => {
    const explodingLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {
        throw new Error('logger dead');
      },
      error: () => {
        throw new Error('logger dead');
      },
      child() {
        return this;
      },
    } as unknown as Logger;
    const deps = buildDeps({
      logger: explodingLogger,
      getTaskRunCounts: vi
        .fn()
        .mockResolvedValue([counts({ total: 100, completed: 0, failed: 100 })]),
    });
    await expect(runFailureRateMonitor(deps)).resolves.toBeDefined();
  });

  it('never reaches the LLM gateway: no ai/ import in the module source', () => {
    // Structural proof, not a mock: the monitor's whole job is to watch for
    // runaway LLM usage, so it must not be able to add any.
    const src = readFileSync(
      path.join(__dirname, '../../src/workers/failure-rate-monitor.ts'),
      'utf8',
    );
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual([
      '../logging/logger',
      '../monitoring/metrics',
      '../monitoring/alert-operator',
    ]);
    // No path into the AI tree, and no dynamic escape hatch around the
    // static-import check above.
    expect(imports.some((i) => i.includes('/ai/') || i.startsWith('../ai'))).toBe(false);
    expect(src).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
  });

  it('runs on a bounded cadence, not a hot loop', () => {
    expect(FAILURE_MONITOR_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suppression — the real delivery seam, not a stand-in
// ─────────────────────────────────────────────────────────────────────────────
describe('suppression via the shared alertOperator cooldown', () => {
  const buildAlert = (now: () => number) => {
    const captured: string[] = [];
    const alertOperator = createAlertOperator({
      sentry: {
        captureMessage: (msg: string) => {
          captured.push(msg);
        },
      } as never,
      delivery: null,
      alertSmsTo: undefined,
      cooldownMs: 60 * 60 * 1000,
      logger: noopLogger,
      now,
    });
    return { alertOperator, captured };
  };

  const depsWith = (
    alert: (a: Parameters<FailureRateMonitorDeps['alert']>[0]) => Promise<void>,
    now: () => Date,
  ): FailureRateMonitorDeps => ({
    getTaskRunCounts: async () => [
      counts({ taskType: 'supervisor_annotate', total: 285, completed: 0, unresolved: 285 }),
    ],
    getProposalExecutionCounts: async () => healthyProposals,
    alert,
    thresholds,
    logger: noopLogger,
    now,
  });

  it('suppression prevents repeat alerts for the same ongoing condition', async () => {
    let clock = 1_700_000_000_000;
    const { alertOperator, captured } = buildAlert(() => clock);
    const deps = depsWith(alertOperator, () => new Date(clock));

    // Three consecutive ticks, 10 minutes apart, same ongoing storm.
    await runFailureRateMonitor(deps);
    clock += FAILURE_MONITOR_INTERVAL_MS;
    await runFailureRateMonitor(deps);
    clock += FAILURE_MONITOR_INTERVAL_MS;
    const third = await runFailureRateMonitor(deps);

    // The rule breaches on every tick...
    expect(third.breached).toEqual(['ai_task_failure_rate:supervisor_annotate']);
    // ...but the human is paged exactly once.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('ai_task_failure_rate:supervisor_annotate');

    // Past the cooldown it pages again — a still-broken system re-pages.
    clock += 61 * 60 * 1000;
    await runFailureRateMonitor(deps);
    expect(captured).toHaveLength(2);
  });

  it('cooldown is keyed per task type, so one noisy task cannot mask another', async () => {
    const clock = 1_700_000_000_000;
    const { alertOperator, captured } = buildAlert(() => clock);
    const deps: FailureRateMonitorDeps = {
      ...depsWith(alertOperator, () => new Date(clock)),
      getTaskRunCounts: async () => [
        counts({ taskType: 'supervisor_annotate', total: 285, completed: 0, unresolved: 285 }),
        counts({ taskType: 'classify_intent', total: 1563, completed: 238, failed: 1325 }),
      ],
    };
    await runFailureRateMonitor(deps);
    expect(captured).toHaveLength(2);
    // Same tick, same cooldown window — still two distinct pages.
    await runFailureRateMonitor(deps);
    expect(captured).toHaveLength(2);
  });
});
