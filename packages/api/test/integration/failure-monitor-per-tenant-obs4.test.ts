/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration` (or an
 * EXTERNAL_TEST_DB_URL with the full schema applied).
 *
 * OBS-4 — the failure-rate monitor's platform rule is a cross-tenant
 * `GROUP BY task_type`, so ONE tenant's total AI outage is diluted by healthy
 * tenants' traffic and never pages. This pins the per-tenant aggregate
 * (`PgFailureMonitorRepository.tenantTaskRunCounts`, GROUP BY tenant_id,
 * task_type with SUM(cost_micro_cents)) against REAL Postgres — the exact
 * column names, the half-open window, BIGINT-as-string coercion, NULL cost
 * counting as 0 — and then runs the REAL `runFailureRateMonitor` tick over
 * the real repository under `withCrossTenantSweep`: two tenants, one failing
 * and one healthy, and only the failing one pages.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgFailureMonitorRepository } from '../../src/monitoring/pg-failure-monitor';
import {
  evaluateTaskFailureRate,
  evaluateTenantTaskFailureRate,
  runFailureRateMonitor,
  type FailureMonitorThresholds,
} from '../../src/workers/failure-rate-monitor';
import type { Logger } from '../../src/logging/logger';
import { LLMGateway, type LLMProvider } from '../../src/ai/gateway/gateway';
import { PgAiRunRepository } from '../../src/ai/pg-ai-run';

const NOW = new Date('2026-07-23T12:00:00.000Z');
const WINDOW_END = new Date('2026-07-23T11:55:00.000Z'); // now - settle 5
const WINDOW_START = new Date('2026-07-23T11:25:00.000Z'); // end - window 30
const IN_WINDOW = new Date('2026-07-23T11:40:00.000Z');
const BEFORE_WINDOW = new Date('2026-07-23T11:24:59.000Z');
const AT_WINDOW_END = WINDOW_END; // exclusive upper bound — must NOT count

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

describe('Postgres integration — OBS-4 per-tenant failure rate and window spend', () => {
  let pool: Pool;
  let repo: PgFailureMonitorRepository;
  let failing: TestTenant;
  let healthy: TestTenant;

  async function seedRuns(
    tenantId: string,
    taskType: string,
    n: number,
    opts: { status: 'completed' | 'failed' | 'pending'; cost: number | null; createdAt?: Date },
  ): Promise<void> {
    for (let i = 0; i < n; i++) {
      await pool.query(
        `INSERT INTO ai_runs (tenant_id, task_type, model, status, error_message, cost_micro_cents,
                              created_by, created_at)
         VALUES ($1, $2, 'claude-haiku-4-5-20251001', $3, $4, $5, 'gateway', $6)`,
        [
          tenantId,
          taskType,
          opts.status,
          opts.status === 'failed' ? 'Tenant token budget exceeded' : null,
          opts.cost,
          opts.createdAt ?? IN_WINDOW,
        ],
      );
    }
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgFailureMonitorRepository(pool);
    failing = await createTestTenant(pool);
    healthy = await createTestTenant(pool);

    // Failing tenant: 12 classify_intent calls, every one rejected by its
    // quota bucket (the gateway records the rejection as status='failed').
    await seedRuns(failing.tenantId, 'classify_intent', 12, { status: 'failed', cost: null });
    // Healthy tenant: 60 completed classify_intent calls at 0.7 cents each,
    // plus 5 completed summaries with an UNPRICED model (NULL cost).
    await seedRuns(healthy.tenantId, 'classify_intent', 60, { status: 'completed', cost: 700_000 });
    await seedRuns(healthy.tenantId, 'summarize_conversation', 5, { status: 'completed', cost: null });
    // Outside the window on both sides — must not count anywhere.
    await seedRuns(failing.tenantId, 'classify_intent', 30, {
      status: 'failed',
      cost: 5_000_000,
      createdAt: BEFORE_WINDOW,
    });
    await seedRuns(failing.tenantId, 'classify_intent', 30, {
      status: 'failed',
      cost: 5_000_000,
      createdAt: AT_WINDOW_END,
    });
  }, 120_000);

  afterAll(async () => {
    await pool.query('DELETE FROM ai_runs WHERE tenant_id = ANY($1::uuid[])', [
      [failing.tenantId, healthy.tenantId],
    ]);
    await closeSharedTestDb();
  });

  it('tenantTaskRunCounts groups the settled window by tenant AND task with the window spend', async () => {
    const rows = await repo.tenantTaskRunCounts(WINDOW_START, WINDOW_END);
    const ours = rows.filter((r) => r.tenantId === failing.tenantId || r.tenantId === healthy.tenantId);
    expect(ours).toEqual(
      expect.arrayContaining([
        {
          tenantId: failing.tenantId,
          taskType: 'classify_intent',
          total: 12,
          completed: 0,
          failed: 12,
          unresolved: 0,
          costMicroCents: 0, // every run unpriced → 0, never a guess
          unpricedCompleted: 0, // failed runs are not completed spend
        },
        {
          tenantId: healthy.tenantId,
          taskType: 'classify_intent',
          total: 60,
          completed: 60,
          failed: 0,
          unresolved: 0,
          costMicroCents: 42_000_000, // 60 × 700,000 — a JS number, not pg's BIGINT string
          unpricedCompleted: 0,
        },
        {
          tenantId: healthy.tenantId,
          taskType: 'summarize_conversation',
          total: 5,
          completed: 5,
          failed: 0,
          unresolved: 0,
          costMicroCents: 0,
          unpricedCompleted: 5, // completed with NULL cost — the spend rule's blind spot
        },
      ]),
    );
    expect(ours).toHaveLength(3);
    for (const r of ours) expect(typeof r.costMicroCents).toBe('number');
  });

  it('the platform aggregate is diluted (12/72 = 16.7%) while the per-tenant aggregate is not', async () => {
    // Review round 1: this used to read only the platform aggregate and
    // assert row counts, so it passed with the fix reverted. It now judges
    // BOTH real aggregates with the real evaluators.
    const platform = await repo.taskRunCounts(WINDOW_START, WINDOW_END);
    const classify = platform.find((r) => r.taskType === 'classify_intent')!;
    // Other files' leftovers could in principle add rows; ours alone are
    // 72 runs / 60 completed. Judge OUR share so a leftover cannot flip it.
    expect(classify.total).toBeGreaterThanOrEqual(72);
    const ourPlatformRow = { taskType: 'classify_intent', total: 72, completed: 60, failed: 12, unresolved: 0 };
    expect(evaluateTaskFailureRate(ourPlatformRow, thresholds)!.breached).toBe(false);

    const perTenant = await repo.tenantTaskRunCounts(WINDOW_START, WINDOW_END);
    const failingRow = perTenant.find(
      (r) => r.tenantId === failing.tenantId && r.taskType === 'classify_intent',
    )!;
    const healthyRow = perTenant.find(
      (r) => r.tenantId === healthy.tenantId && r.taskType === 'classify_intent',
    )!;
    const failingFinding = evaluateTenantTaskFailureRate(failingRow, thresholds)!;
    expect(failingFinding.breached).toBe(true);
    expect(failingFinding.value).toBe(1);
    expect(evaluateTenantTaskFailureRate(healthyRow, thresholds)!.breached).toBe(false);
  });

  it('the real tick over the real repository pages ONLY the failing tenant', async () => {
    const alert = vi.fn().mockResolvedValue(undefined);
    const result = await runFailureRateMonitor({
      getTaskRunCounts: (s, e) => repo.taskRunCounts(s, e),
      getTenantTaskRunCounts: (s, e) => repo.tenantTaskRunCounts(s, e),
      getProposalExecutionCounts: (s, f) => repo.proposalExecutionCounts(s, f),
      alert,
      thresholds,
      logger: noopLogger,
      now: () => NOW,
    });

    expect(result.evaluated).toEqual([
      'ai_task_failure_rate',
      'ai_tenant_task_failure_rate',
      'ai_spend_window',
      'ai_spend_unpriced',
      'proposal_execution_stalled',
      'proposal_execution_failed_silently',
    ]);
    const failingRule = `ai_task_failure_rate:classify_intent:${failing.tenantId}`;
    expect(result.breached).toContain(failingRule);
    expect(result.breached).not.toContain(`ai_task_failure_rate:classify_intent:${healthy.tenantId}`);
    expect(result.breached).not.toContain('ai_task_failure_rate:classify_intent');
    expect(result.breached).not.toContain('ai_spend_window');
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: failingRule,
        severity: 'critical',
        details: expect.objectContaining({
          tenantId: failing.tenantId,
          taskType: 'classify_intent',
          total: 12,
          completed: 0,
          failed: 12,
        }),
      }),
    );
    expect(alert).not.toHaveBeenCalledWith(
      expect.objectContaining({ rule: `ai_task_failure_rate:classify_intent:${healthy.tenantId}` }),
    );
  });

  it('a completed gateway call on the live production model stores a real cost the spend rule can see', async () => {
    // OBS-4 review round 1. Production runs AI Profile A (gpt-4o-mini
    // primary), and OpenAI answers with a dated id. While that model was
    // unpriced the gateway wrote cost_micro_cents NULL, the window SUM read
    // 0 and ai_spend_window could never fire. Drive the REAL gateway into
    // the REAL ai_runs table and read it back through the monitor's query.
    const live = await createTestTenant(pool);
    try {
      // OpenAI answers a 'gpt-4o-mini' request with the dated snapshot id.
      const openai: LLMProvider = {
        name: 'openai',
        async complete() {
          return {
            content: 'ok',
            model: 'gpt-4o-mini-2024-07-18',
            provider: 'openai',
            tokenUsage: { input: 9000, output: 100, total: 9100 },
            latencyMs: 0,
          };
        },
        async isAvailable() {
          return true;
        },
      };
      const gateway = new LLMGateway(
        { defaultProvider: 'openai' },
        new Map<string, LLMProvider>([['openai', openai]]),
        undefined,
        new PgAiRunRepository(pool),
      );
      const started = new Date(Date.now() - 1000);
      const response = await gateway.complete({
        taskType: 'classify_intent',
        model: 'gpt-4o-mini',
        tenantId: live.tenantId,
        messages: [{ role: 'user', content: 'Book Maria for Tuesday' }],
      });
      // 9,000 × 15 + 100 × 60 = 141,000 micro-cents.
      expect(response.costMicroCents).toBe(141_000);

      const { rows } = await pool.query(
        `SELECT status, model, cost_micro_cents FROM ai_runs WHERE tenant_id = $1`,
        [live.tenantId],
      );
      expect(rows).toEqual([
        { status: 'completed', model: 'gpt-4o-mini-2024-07-18', cost_micro_cents: '141000' },
      ]);

      const counted = (await repo.tenantTaskRunCounts(started, new Date(Date.now() + 1000))).find(
        (r) => r.tenantId === live.tenantId,
      );
      expect(counted).toMatchObject({ completed: 1, costMicroCents: 141_000, unpricedCompleted: 0 });
    } finally {
      await pool.query('DELETE FROM ai_runs WHERE tenant_id = $1', [live.tenantId]);
    }
  });

  it('a window of completed runs on an unpriced model pages the blind-spend warning', async () => {
    const blind = await createTestTenant(pool);
    try {
      await pool.query(
        `INSERT INTO ai_runs (tenant_id, task_type, model, status, cost_micro_cents, created_by, created_at)
         SELECT $1, 'supervisor_annotate', 'some-unpriced-model', 'completed', NULL, 'gateway', $2
         FROM generate_series(1, 2000)`,
        [blind.tenantId, IN_WINDOW],
      );
      const alert = vi.fn().mockResolvedValue(undefined);
      const result = await runFailureRateMonitor({
        getTaskRunCounts: (s, e) => repo.taskRunCounts(s, e),
        getTenantTaskRunCounts: (s, e) => repo.tenantTaskRunCounts(s, e),
        getProposalExecutionCounts: (s, f) => repo.proposalExecutionCounts(s, f),
        alert,
        thresholds,
        logger: noopLogger,
        now: () => NOW,
      });
      expect(result.breached).toContain('ai_spend_unpriced');
      expect(result.breached).not.toContain('ai_spend_window');
      const call = alert.mock.calls.find(([a]) => a.rule === 'ai_spend_unpriced');
      expect(call![0].severity).toBe('warning');
      expect(call![0].details.topTaskTypes).toContain('supervisor_annotate=2000');
    } finally {
      await pool.query('DELETE FROM ai_runs WHERE tenant_id = $1', [blind.tenantId]);
    }
  });

  it('the spend rule pages on a completing loop that the failure rules cannot see', async () => {
    // 1,100 completed runs at 2 cents each in the window = 2,200 cents > 2,000.
    const loop = await createTestTenant(pool);
    try {
      await pool.query(
        `INSERT INTO ai_runs (tenant_id, task_type, model, status, cost_micro_cents, created_by, created_at)
         SELECT $1, 'supervisor_annotate', 'claude-sonnet-4-6', 'completed', 2000000, 'gateway', $2
         FROM generate_series(1, 1100)`,
        [loop.tenantId, IN_WINDOW],
      );
      const alert = vi.fn().mockResolvedValue(undefined);
      const result = await runFailureRateMonitor({
        getTaskRunCounts: (s, e) => repo.taskRunCounts(s, e),
        getTenantTaskRunCounts: (s, e) => repo.tenantTaskRunCounts(s, e),
        getProposalExecutionCounts: (s, f) => repo.proposalExecutionCounts(s, f),
        alert,
        thresholds,
        logger: noopLogger,
        now: () => NOW,
      });
      expect(result.breached).toContain('ai_spend_window');
      expect(result.breached).not.toContain('ai_task_failure_rate:supervisor_annotate');
      expect(result.breached).not.toContain(`ai_task_failure_rate:supervisor_annotate:${loop.tenantId}`);
      const spendCall = alert.mock.calls.find(([a]) => a.rule === 'ai_spend_window');
      expect(spendCall).toBeDefined();
      expect(spendCall![0].details.topTenants).toContain(`${loop.tenantId}=2200.00c`);
      expect(spendCall![0].details.topTaskTypes).toContain('supervisor_annotate=2200.00c');
    } finally {
      await pool.query('DELETE FROM ai_runs WHERE tenant_id = $1', [loop.tenantId]);
    }
  });
});
