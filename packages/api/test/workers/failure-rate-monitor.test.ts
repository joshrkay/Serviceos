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
  evaluateTenantTaskFailureRate,
  evaluateWindowSpend,
  evaluateUnpricedSpend,
  evaluateStalledExecutions,
  evaluateSilentExecutionFailures,
  runFailureRateMonitor,
  FAILURE_MONITOR_INTERVAL_MS,
  type FailureMonitorThresholds,
  type FailureRateMonitorDeps,
  type ProposalExecutionCounts,
  type TaskRunCounts,
  type TenantTaskRunCounts,
} from '../../src/workers/failure-rate-monitor';
import { createAlertOperator } from '../../src/monitoring/alert-operator';
import { sloAlertsSentTotal } from '../../src/monitoring/metrics';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import type { Logger } from '../../src/logging/logger';

const thresholds: FailureMonitorThresholds = {
  windowMin: 30,
  settleMin: 5,
  rateMax: 0.25,
  minRuns: 20,
  maxTaskAlerts: 3,
  proposalStaleMin: 15,
  proposalLookbackHours: 24,
  tenantMinRuns: 10,
  spendMaxCents: 2000,
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

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function tenantCounts(over: Partial<TenantTaskRunCounts>): TenantTaskRunCounts {
  return {
    tenantId: TENANT_A,
    taskType: 'classify_intent',
    total: 0,
    completed: 0,
    failed: 0,
    unresolved: 0,
    costMicroCents: 0,
    unpricedCompleted: 0,
    ...over,
  };
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
      getTenantTaskRunCounts: vi.fn().mockResolvedValue([]),
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
      'ai_tenant_task_failure_rate',
      'ai_spend_window',
      'ai_spend_unpriced',
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
      getTenantTaskRunCounts: vi.fn().mockResolvedValue([]),
      getProposalExecutionCounts: vi.fn().mockResolvedValue(healthyProposals),
      alert: vi.fn().mockResolvedValue(undefined),
      thresholds,
      logger: noopLogger,
      ...overrides,
    }) as FailureRateMonitorDeps & { alert: ReturnType<typeof vi.fn> };

  it('a thrown error inside the check does not escape', async () => {
    const deps = buildDeps({
      getTaskRunCounts: vi.fn().mockRejectedValue(new Error('db down')),
      getTenantTaskRunCounts: vi.fn().mockRejectedValue(new Error('db down')),
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
      getTenantTaskRunCounts: vi.fn().mockRejectedValue(new Error('ai_runs read exploded')),
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
    getTenantTaskRunCounts: async () => [],
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

// ─────────────────────────────────────────────────────────────────────────────
// OBS-4 — per-tenant non-completion rate. The platform rule is a cross-tenant
// aggregate, so one tenant's total outage is diluted by healthy tenants'
// traffic and never breaches unless that tenant is >25% of platform volume.
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateTenantTaskFailureRate', () => {
  it('fires on one tenant failing 100% at its own floor, keyed per task AND tenant', () => {
    const r = evaluateTenantTaskFailureRate(
      tenantCounts({ total: 12, completed: 0, failed: 12 }),
      thresholds,
    );
    expect(r).not.toBeNull();
    expect(r!.breached).toBe(true);
    expect(r!.rule).toBe(`ai_task_failure_rate:classify_intent:${TENANT_A}`);
    expect(r!.value).toBe(1);
    expect(r!.severity).toBe('critical');
    expect(r!.details.tenantId).toBe(TENANT_A);
  });

  it('has its OWN volume floor, below the platform floor (12 runs: platform null, tenant breaches)', () => {
    const row = tenantCounts({ total: 12, completed: 0, failed: 12 });
    expect(evaluateTaskFailureRate(row, thresholds)).toBeNull(); // platform floor is 20
    expect(evaluateTenantTaskFailureRate(row, thresholds)!.breached).toBe(true); // tenant floor is 10
    expect(
      evaluateTenantTaskFailureRate(tenantCounts({ total: 9, completed: 0, failed: 9 }), thresholds),
    ).toBeNull();
  });

  it('does not fire at or below the rate threshold', () => {
    const r = evaluateTenantTaskFailureRate(
      tenantCounts({ total: 40, completed: 30, failed: 10 }),
      thresholds,
    );
    expect(r!.value).toBeCloseTo(0.25);
    expect(r!.breached).toBe(false);
  });
});

describe('runFailureRateMonitor — OBS-4 per-tenant rule', () => {
  const buildDeps = (
    overrides: Partial<FailureRateMonitorDeps> = {},
  ): FailureRateMonitorDeps & { alert: ReturnType<typeof vi.fn> } =>
    ({
      getTaskRunCounts: vi.fn().mockResolvedValue([]),
      getTenantTaskRunCounts: vi.fn().mockResolvedValue([]),
      getProposalExecutionCounts: vi.fn().mockResolvedValue(healthyProposals),
      alert: vi.fn().mockResolvedValue(undefined),
      thresholds,
      logger: noopLogger,
      ...overrides,
    }) as FailureRateMonitorDeps & { alert: ReturnType<typeof vi.fn> };

  it('a single tenant failing 100% inside a healthy platform pages the per-tenant rule, not the platform rule', async () => {
    // Tenant A: 12 classify_intent calls, all rejected (quota / budget).
    // Tenant B: 60 calls, all completed. Platform-wide that is 12/72 = 16.7%
    // non-completion — UNDER the 25% threshold, so the platform rule is quiet.
    // This is exactly the dilution OBS-4 describes.
    const deps = buildDeps({
      getTaskRunCounts: vi
        .fn()
        .mockResolvedValue([counts({ taskType: 'classify_intent', total: 72, completed: 60, failed: 12 })]),
      getTenantTaskRunCounts: vi.fn().mockResolvedValue([
        tenantCounts({ tenantId: TENANT_A, total: 12, completed: 0, failed: 12 }),
        tenantCounts({ tenantId: TENANT_B, total: 60, completed: 60 }),
      ]),
    });
    const result = await runFailureRateMonitor(deps);
    expect(result.breached).toEqual([`ai_task_failure_rate:classify_intent:${TENANT_A}`]);
    expect(deps.alert).toHaveBeenCalledTimes(1);
    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: `ai_task_failure_rate:classify_intent:${TENANT_A}`,
        severity: 'critical',
        details: expect.objectContaining({ tenantId: TENANT_A, total: 12, completed: 0 }),
      }),
    );
    expect(deps.alert).not.toHaveBeenCalledWith(
      expect.objectContaining({ rule: 'ai_task_failure_rate:classify_intent' }),
    );
  });

  it('reads the per-tenant aggregate over the SAME settled window as the platform rule', async () => {
    const getTenantTaskRunCounts = vi.fn().mockResolvedValue([]);
    await runFailureRateMonitor(
      buildDeps({ getTenantTaskRunCounts, now: () => new Date('2026-07-24T12:00:00Z') }),
    );
    expect(getTenantTaskRunCounts).toHaveBeenCalledWith(
      new Date('2026-07-24T11:25:00Z'),
      new Date('2026-07-24T11:55:00Z'),
    );
  });

  it('a platform-wide breach subsumes the per-tenant breaches of that task: one page, not one per tenant', async () => {
    // Every tenant is down because the task itself is down. The platform
    // page says so; fanning out one page per tenant would be the storm this
    // monitor exists to avoid.
    const deps = buildDeps({
      getTaskRunCounts: vi
        .fn()
        .mockResolvedValue([counts({ taskType: 'classify_intent', total: 72, completed: 0, failed: 72 })]),
      getTenantTaskRunCounts: vi.fn().mockResolvedValue([
        tenantCounts({ tenantId: TENANT_A, total: 12, completed: 0, failed: 12 }),
        tenantCounts({ tenantId: TENANT_B, total: 60, completed: 0, failed: 60 }),
      ]),
    });
    const result = await runFailureRateMonitor(deps);
    expect(deps.alert).toHaveBeenCalledTimes(1);
    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({ rule: 'ai_task_failure_rate:classify_intent' }),
    );
    // Subsumed breaches stay visible in the result (and the log), unpaged.
    expect(result.breached).toEqual([
      'ai_task_failure_rate:classify_intent',
      `ai_task_failure_rate:classify_intent:${TENANT_A}`,
      `ai_task_failure_rate:classify_intent:${TENANT_B}`,
    ]);
    expect(result.suppressedByCap).toEqual([]);
  });

  it('caps per-tenant pages per tick (worst first), separately from the platform cap', async () => {
    const tenants = ['a', 'b', 'c', 'd', 'e'].map((suffix, i) =>
      tenantCounts({
        tenantId: `tenant-${suffix}`,
        taskType: 'draft_estimate',
        total: 20,
        completed: i,
        failed: 20 - i,
      }),
    );
    const deps = buildDeps({
      // Platform-wide 100 runs, 90 non-complete: draft_estimate breaches
      // ONLY for a different task so the per-tenant ones are not subsumed.
      getTaskRunCounts: vi
        .fn()
        .mockResolvedValue([counts({ taskType: 'summarize_conversation', total: 100, completed: 0, failed: 100 })]),
      getTenantTaskRunCounts: vi.fn().mockResolvedValue(tenants),
    });
    const result = await runFailureRateMonitor(deps);
    // 1 platform page + 3 of 5 tenant pages (maxTaskAlerts=3 each).
    expect(deps.alert).toHaveBeenCalledTimes(4);
    expect(result.suppressedByCap).toEqual([
      'ai_task_failure_rate:draft_estimate:tenant-d',
      'ai_task_failure_rate:draft_estimate:tenant-e',
    ]);
    expect(result.breached).toHaveLength(6);
  });

  it('cooldown is keyed per tenant through the real alertOperator, so one tenant cannot mask another', async () => {
    const clock = 1_700_000_000_000;
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
      now: () => clock,
    });
    const deps = buildDeps({
      alert: alertOperator,
      now: () => new Date(clock),
      getTaskRunCounts: vi
        .fn()
        .mockResolvedValue([counts({ taskType: 'classify_intent', total: 500, completed: 476, failed: 24 })]),
      getTenantTaskRunCounts: vi.fn().mockResolvedValue([
        tenantCounts({ tenantId: TENANT_A, total: 12, completed: 0, failed: 12 }),
        tenantCounts({ tenantId: TENANT_B, total: 12, completed: 0, failed: 12 }),
        tenantCounts({ tenantId: 'healthy', total: 476, completed: 476 }),
      ]),
    });
    await runFailureRateMonitor(deps);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain(`ai_task_failure_rate:classify_intent:${TENANT_A}`);
    expect(captured[1]).toContain(`ai_task_failure_rate:classify_intent:${TENANT_B}`);
    // Same tick, same cooldown window — nothing re-pages.
    await runFailureRateMonitor(deps);
    expect(captured).toHaveLength(2);
  });

  it('a per-tenant page never writes the tenant id into a metric label (cooldown stays per tenant)', async () => {
    // Review round 101 (panel:privacy): the cooldown key carries the tenant,
    // but slo_alerts_sent_total is a permanent, scraped series with no purge
    // on tenant erasure — its rule label must be the bounded per-task family.
    const tenant = '33333333-3333-4333-8333-333333333333';
    sloAlertsSentTotal.reset();
    const delivery = new InMemoryDeliveryProvider();
    const captured: string[] = [];
    const alertOperator = createAlertOperator({
      sentry: {
        captureMessage: (msg: string) => {
          captured.push(msg);
        },
      } as never,
      delivery,
      alertSmsTo: '+15551230000',
      cooldownMs: 60 * 60 * 1000,
      logger: noopLogger,
      now: () => 1_700_000_000_000,
    });
    await runFailureRateMonitor(
      buildDeps({
        alert: alertOperator,
        getTaskRunCounts: vi
          .fn()
          .mockResolvedValue([counts({ taskType: 'classify_intent', total: 500, completed: 490, failed: 10 })]),
        getTenantTaskRunCounts: vi.fn().mockResolvedValue([
          tenantCounts({ tenantId: tenant, total: 10, completed: 0, failed: 10 }),
          tenantCounts({ tenantId: 'healthy', total: 490, completed: 490 }),
        ]),
      }),
    );
    // The page itself still names the tenant (Sentry + SMS) so the responder can act.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(tenant);
    expect(delivery.sentSms).toHaveLength(1);

    const series = (await sloAlertsSentTotal.get()).values;
    expect(series.map((v) => [v.labels.rule, v.labels.channel, v.value])).toEqual([
      ['ai_task_failure_rate_tenant:classify_intent', 'sentry', 1],
      ['ai_task_failure_rate_tenant:classify_intent', 'sms', 1],
    ]);
    for (const v of series) {
      for (const label of Object.values(v.labels)) {
        expect(String(label)).not.toContain(tenant);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OBS-4 — platform spend. A loop that re-calls the model but COMPLETES every
// call keeps rule 1 at 0%; only the bill moves.
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateWindowSpend', () => {
  it('breaches over the cap with 100% completion, naming the top tenants and tasks', () => {
    // 1,500 completed supervisor_annotate runs at 2 cents each = 3,000 cents
    // in one window; threshold 2,000 cents.
    const r = evaluateWindowSpend(
      [
        tenantCounts({ tenantId: TENANT_A, taskType: 'supervisor_annotate', total: 1500, completed: 1500, costMicroCents: 1500 * 2_000_000 }),
        tenantCounts({ tenantId: TENANT_B, taskType: 'classify_intent', total: 60, completed: 60, costMicroCents: 60 * 700_000 }),
      ],
      thresholds,
    );
    expect(r).not.toBeNull();
    expect(r!.breached).toBe(true);
    expect(r!.rule).toBe('ai_spend_window');
    expect(r!.value).toBe(3_042_000_000);
    expect(r!.details.totalCents).toBe(3042);
    expect(r!.details.thresholdCents).toBe(2000);
    expect(r!.details.topTenants).toBe(`${TENANT_A}=3000.00c,${TENANT_B}=42.00c`);
    expect(r!.details.topTaskTypes).toBe('supervisor_annotate=3000.00c,classify_intent=42.00c');
    expect(r!.severity).toBe('critical');
  });

  it('is quiet at or under the cap (breach is strictly above), and unpriced runs count 0', () => {
    const atCap = evaluateWindowSpend(
      [tenantCounts({ costMicroCents: 2000 * 1_000_000 })],
      thresholds,
    );
    expect(atCap!.breached).toBe(false);
    expect(evaluateWindowSpend([tenantCounts({ costMicroCents: 0 })], thresholds)!.breached).toBe(false);
    expect(evaluateWindowSpend([], thresholds)!.value).toBe(0);
  });

  it('is off when the threshold is 0', () => {
    expect(
      evaluateWindowSpend([tenantCounts({ costMicroCents: 10 ** 12 })], { ...thresholds, spendMaxCents: 0 }),
    ).toBeNull();
  });
});

describe('runFailureRateMonitor — OBS-4 spend rule', () => {
  it('pages ai_spend_window on a completing runaway loop while every failure rule stays quiet', async () => {
    const rows = [
      tenantCounts({ tenantId: TENANT_A, taskType: 'supervisor_annotate', total: 1500, completed: 1500, costMicroCents: 1500 * 2_000_000 }),
    ];
    const deps: FailureRateMonitorDeps & { alert: ReturnType<typeof vi.fn> } = {
      getTaskRunCounts: vi
        .fn()
        .mockResolvedValue([counts({ taskType: 'supervisor_annotate', total: 1500, completed: 1500 })]),
      getTenantTaskRunCounts: vi.fn().mockResolvedValue(rows),
      getProposalExecutionCounts: vi.fn().mockResolvedValue(healthyProposals),
      alert: vi.fn().mockResolvedValue(undefined),
      thresholds,
      logger: noopLogger,
    };
    const result = await runFailureRateMonitor(deps);
    expect(result.breached).toEqual(['ai_spend_window']);
    expect(deps.alert).toHaveBeenCalledTimes(1);
    expect(deps.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: 'ai_spend_window',
        severity: 'critical',
        details: expect.objectContaining({ totalCents: 3000, thresholdCents: 2000 }),
      }),
    );
  });

  it('does not evaluate the spend rule when it is turned off', async () => {
    const getTenantTaskRunCounts = vi
      .fn()
      .mockResolvedValue([tenantCounts({ costMicroCents: 10 ** 12, completed: 500, total: 500, unpricedCompleted: 500 })]);
    const deps: FailureRateMonitorDeps = {
      getTaskRunCounts: vi.fn().mockResolvedValue([]),
      getTenantTaskRunCounts,
      getProposalExecutionCounts: vi.fn().mockResolvedValue(healthyProposals),
      alert: vi.fn().mockResolvedValue(undefined),
      thresholds: { ...thresholds, spendMaxCents: 0 },
      logger: noopLogger,
    };
    const result = await runFailureRateMonitor(deps);
    // Positive control (review round 1): the per-tenant rows WERE read and
    // the per-tenant rule ran — only the spend rules were skipped. Without
    // this the test passes on code that has no spend rule at all.
    expect(getTenantTaskRunCounts).toHaveBeenCalledTimes(1);
    expect(result.evaluated).toContain('ai_tenant_task_failure_rate');
    expect(result.evaluated).not.toContain('ai_spend_window');
    expect(result.evaluated).not.toContain('ai_spend_unpriced');
    expect(result.breached).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OBS-4 review round 1 — the spend rule must not go silently blind. Every
// live run on an unpriced model stores cost NULL and sums as 0, so a window
// full of unpriced completions reads as "no spend" and the rule can never
// fire. That shape pages a warning naming the blind spot.
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateUnpricedSpend', () => {
  it('warns when most completed runs in the window carry no price', () => {
    const r = evaluateUnpricedSpend(
      [
        tenantCounts({ tenantId: TENANT_A, taskType: 'supervisor_annotate', total: 900, completed: 900, unpricedCompleted: 900 }),
        tenantCounts({ tenantId: TENANT_B, taskType: 'classify_intent', total: 100, completed: 100, unpricedCompleted: 40, costMicroCents: 60 * 135_000 }),
      ],
      thresholds,
    );
    expect(r).not.toBeNull();
    expect(r!.rule).toBe('ai_spend_unpriced');
    expect(r!.breached).toBe(true);
    expect(r!.severity).toBe('warning');
    expect(r!.value).toBeCloseTo(0.94);
    expect(r!.details.unpricedCompleted).toBe(940);
    expect(r!.details.completed).toBe(1000);
    expect(r!.details.topTaskTypes).toBe('supervisor_annotate=900,classify_intent=40');
    expect(r!.summary).toMatch(/AI_MODEL_PRICING_JSON/);
  });

  it('is quiet when unpriced runs are a small share or below the volume floor', () => {
    // 5 of 200 = 2.5% — an occasional unpriced side task is not a blind rule.
    expect(
      evaluateUnpricedSpend(
        [tenantCounts({ total: 200, completed: 200, unpricedCompleted: 5 })],
        thresholds,
      )!.breached,
    ).toBe(false);
    // 15 of 15 is 100% but under the 20-run floor — not enough to judge.
    expect(
      evaluateUnpricedSpend(
        [tenantCounts({ total: 15, completed: 15, unpricedCompleted: 15 })],
        thresholds,
      )!.breached,
    ).toBe(false);
    expect(evaluateUnpricedSpend([], thresholds)!.breached).toBe(false);
  });

  it('is off with the spend rule (threshold 0)', () => {
    expect(
      evaluateUnpricedSpend(
        [tenantCounts({ total: 900, completed: 900, unpricedCompleted: 900 })],
        { ...thresholds, spendMaxCents: 0 },
      ),
    ).toBeNull();
  });

  it('the tick pages the blind-spend warning while ai_spend_window reads 0', async () => {
    const alert = vi.fn().mockResolvedValue(undefined);
    const result = await runFailureRateMonitor({
      getTaskRunCounts: vi.fn().mockResolvedValue([]),
      getTenantTaskRunCounts: vi
        .fn()
        .mockResolvedValue([
          tenantCounts({ taskType: 'supervisor_annotate', total: 5000, completed: 5000, unpricedCompleted: 5000 }),
        ]),
      getProposalExecutionCounts: vi.fn().mockResolvedValue(healthyProposals),
      alert,
      thresholds,
      logger: noopLogger,
    });
    expect(result.evaluated).toContain('ai_spend_window');
    expect(result.evaluated).toContain('ai_spend_unpriced');
    expect(result.breached).toEqual(['ai_spend_unpriced']);
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ rule: 'ai_spend_unpriced', severity: 'warning' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OBS-4 review round 1 — the SHIPPED default spend threshold must be
// reachable at today's scale. Per-tenant spend is capped by the gateway's
// token buckets, so the only loop this rule exists for is one that fans
// out across tenants; the default must page when a handful of tenants are
// driven to their bucket ceiling at production prices.
// ─────────────────────────────────────────────────────────────────────────────
describe('ai_spend_window — the shipped default is reachable at current scale', () => {
  /** Few tenants today; a cross-tenant loop saturating this many must page. */
  const CURRENT_SCALE_TENANTS = 4;

  it('N tenants saturating their standard + classifier buckets on gpt-4o-mini breach the default; one tenant does not', async () => {
    const { loadConfig } = await import('../../src/shared/config');
    const { DEFAULT_TIER_CONFIG } = await import('../../src/ai/gateway/tenant-quota');
    // OpenAI models are unpriced by default (GATEWAY-04, #1699); production
    // prices them through AI_MODEL_PRICING_JSON, so this derives the per-
    // tenant ceiling from that same config path. The pricing module reads
    // the env once at load, hence the fresh import.
    const priorPricing = process.env.AI_MODEL_PRICING_JSON;
    process.env.AI_MODEL_PRICING_JSON = JSON.stringify({
      'gpt-4o-mini': { inputCentsPerMillionTokens: 15, outputCentsPerMillionTokens: 60 },
      'gpt-4o': { inputCentsPerMillionTokens: 250, outputCentsPerMillionTokens: 1000 },
    });
    vi.resetModules();
    const { computeCostMicroCents } = await import('../../src/ai/gateway/model-pricing').finally(() => {
      if (priorPricing === undefined) delete process.env.AI_MODEL_PRICING_JSON;
      else process.env.AI_MODEL_PRICING_JSON = priorPricing;
      vi.resetModules();
    });
    const config = loadConfig({ NODE_ENV: 'dev' });
    const windowSec = config.FAILURE_MONITOR_WINDOW_MIN * 60;
    // Every tenant gets 'standard' + 'classifier_standard' (nothing sets
    // tenantTier). A bucket can spend its burst plus refill over a window.
    const saturatedTokens = (['standard', 'classifier_standard'] as const).reduce(
      (sum, tier) =>
        sum + DEFAULT_TIER_CONFIG[tier].bucketCapacity + DEFAULT_TIER_CONFIG[tier].refillTokensPerSec * windowSec,
      0,
    );
    expect(saturatedTokens).toBe(3_550_000);
    // Price every token as INPUT on the live primary — the cheapest case,
    // so the bound is conservative: 3,550,000 × 15 = 53,250,000 micro-cents.
    const perTenantMicroCents = computeCostMicroCents('gpt-4o-mini-2024-07-18', { input: saturatedTokens })!;
    expect(perTenantMicroCents).toBe(53_250_000);

    const defaults = {
      spendMaxCents: config.FAILURE_MONITOR_SPEND_MAX_CENTS,
      windowMin: config.FAILURE_MONITOR_WINDOW_MIN,
    };
    const loopRows = Array.from({ length: CURRENT_SCALE_TENANTS }, (_, i) =>
      tenantCounts({ tenantId: `tenant-${i}`, taskType: 'supervisor_annotate', costMicroCents: perTenantMicroCents }),
    );
    expect(evaluateWindowSpend(loopRows, defaults)!.breached).toBe(true);
    // One tenant at its ceiling is the per-tenant quota's job, not a page.
    expect(evaluateWindowSpend(loopRows.slice(0, 1), defaults)!.breached).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OBS-4 review round 1 — a per-tenant page may only claim the platform-wide
// rate is fine when the platform rule actually judged that task and found
// it under threshold.
// ─────────────────────────────────────────────────────────────────────────────
describe('runFailureRateMonitor — per-tenant page states what the platform rule saw', () => {
  const run = async (getTaskRunCounts: FailureRateMonitorDeps['getTaskRunCounts']) => {
    const alert = vi.fn().mockResolvedValue(undefined);
    await runFailureRateMonitor({
      getTaskRunCounts,
      getTenantTaskRunCounts: vi
        .fn()
        .mockResolvedValue([tenantCounts({ tenantId: TENANT_A, total: 15, completed: 0, failed: 15 })]),
      getProposalExecutionCounts: vi.fn().mockResolvedValue(healthyProposals),
      alert,
      thresholds,
      logger: noopLogger,
    });
    const page = alert.mock.calls.find(([a]) => a.rule === `ai_task_failure_rate:classify_intent:${TENANT_A}`);
    expect(page).toBeDefined();
    return page![0] as { summary: string; details: Record<string, string | number> };
  };

  it('one tenant is ALL of a low-volume task (15/15 failed, under the platform floor): never claims the platform is fine', async () => {
    const page = await run(
      vi.fn().mockResolvedValue([counts({ taskType: 'classify_intent', total: 15, completed: 0, failed: 15 })]),
    );
    expect(page.summary).not.toMatch(/platform-wide rate for this task is below threshold/);
    expect(page.summary).toMatch(/platform-wide rate not judged/);
    expect(page.details.platformRate).toBe('not judged');
  });

  it('the platform read failed: never claims the platform is fine', async () => {
    const page = await run(vi.fn().mockRejectedValue(new Error('pg down')));
    expect(page.summary).not.toMatch(/below threshold/);
    expect(page.summary).toMatch(/platform-wide rate not judged/);
  });

  it('the platform rule judged the task and it was under threshold: says so, with the rate', async () => {
    const page = await run(
      vi.fn().mockResolvedValue([counts({ taskType: 'classify_intent', total: 75, completed: 60, failed: 15 })]),
    );
    expect(page.summary).toMatch(/platform-wide rate for this task is 20\.0%, below threshold/);
    expect(page.details.platformRate).toBe(0.2);
  });
});
