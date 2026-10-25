/**
 * Shadow-comparison retention sweep — the batch loop (#1813 follow-up).
 *
 * The repository seam is faked over an in-test row list so the loop's own
 * behaviour is pinned here: the horizon and bounds it hands the repository,
 * one bounded batch per tenant per sweep (oldest first), per-tenant failure
 * isolation, the audit event each batch hands the repository to write in the
 * DELETE's own transaction (none lands for a tenant with no tenants row: the
 * placeholder bucket, or a deprovisioned tenant's late sample, which is
 * logged), the completion log line and the purge counter. The SQL and the
 * transaction itself are pinned at real Postgres in
 * test/integration/shadow-comparisons-retention.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  runShadowComparisonRetentionSweep,
  summarizePurgedShadowComparisons,
  SHADOW_COMPARISON_RETENTION_SWEEP_BATCH,
  SHADOW_COMPARISON_RETENTION_SWEEP_TENANT_LIMIT,
  type ShadowComparisonPurge,
  type ShadowComparisonPurgeAudit,
  type ShadowComparisonRetentionRepository,
} from '../../src/workers/shadow-comparison-retention-worker';
import { PLACEHOLDER_TENANT_ID } from '../../src/ai/evaluation/pg-shadow-comparison';
import type { AuditEvent } from '../../src/audit/audit';
import { shadowComparisonsPurgedTotal } from '../../src/monitoring/metrics';
import type { Logger } from '../../src/logging/logger';

const NOW = new Date('2026-10-23T12:00:00Z');
const DAY_MS = 24 * 3600 * 1000;
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

interface LoggedLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

function capturingLogger(lines: LoggedLine[]): Logger {
  const push = (level: LoggedLine['level']) => (message: string, meta?: Record<string, unknown>) => {
    lines.push({ level, message, ...(meta ? { meta } : {}) });
  };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return logger;
}

interface FakeRow {
  id: string;
  tenantId: string;
  taskType: string | null;
  createdAt: Date;
}

function ageDays(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/**
 * The repository contract over an in-memory row list, recording every call.
 * A batch and its audit row commit together, as in the Pg repository's one
 * transaction: a failed audit insert keeps the batch's rows.
 */
class FakeRepo implements ShadowComparisonRetentionRepository {
  selections: Array<{ now: Date; retentionDays: number; limit: number }> = [];
  purges: Array<{ tenantId: string; now: Date; retentionDays: number; limit: number }> = [];
  failSelection = false;
  failPurgeFor = new Set<string>();
  /** Tenants with a tenants row (audit_events.tenant_id references tenants). */
  tenantRows = new Set<string>([TENANT_A, TENANT_B]);
  failAuditFor = new Set<string>();
  /** Audit rows committed with their batch. */
  audits: AuditEvent[] = [];

  constructor(public rows: FakeRow[]) {}

  private due(now: Date, retentionDays: number): FakeRow[] {
    const horizon = now.getTime() - retentionDays * DAY_MS;
    return this.rows.filter((r) => r.createdAt.getTime() < horizon);
  }

  async findTenantsWithDue(now: Date, retentionDays: number, limit: number): Promise<string[]> {
    this.selections.push({ now, retentionDays, limit });
    if (this.failSelection) throw new Error('selection exploded');
    const oldest = new Map<string, number>();
    for (const r of this.due(now, retentionDays)) {
      const t = r.createdAt.getTime();
      if (!oldest.has(r.tenantId) || t < oldest.get(r.tenantId)!) oldest.set(r.tenantId, t);
    }
    return [...oldest.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([tenantId]) => tenantId);
  }

  async purgeDue(
    tenantId: string,
    now: Date,
    retentionDays: number,
    limit: number,
    audit: ShadowComparisonPurgeAudit,
  ): Promise<ShadowComparisonPurge> {
    this.purges.push({ tenantId, now, retentionDays, limit });
    if (this.failPurgeFor.has(tenantId)) throw new Error(`purge exploded for ${tenantId}`);
    const batch = this.due(now, retentionDays)
      .filter((r) => r.tenantId === tenantId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
    const rows = batch.map((r) => ({ taskType: r.taskType, createdAt: r.createdAt }));
    let audited = false;
    if (rows.length > 0 && this.tenantRows.has(tenantId)) {
      const event = audit(rows);
      // Rolled back with the audit insert: the rows are not removed.
      if (this.failAuditFor.has(tenantId)) throw new Error(`audit insert failed for ${tenantId}`);
      this.audits.push(event);
      audited = true;
    }
    const ids = new Set(batch.map((r) => r.id));
    this.rows = this.rows.filter((r) => !ids.has(r.id));
    return { rows, audited };
  }
}

function seed(): FakeRow[] {
  return [
    { id: 'a-old-1', tenantId: TENANT_A, taskType: 'classify_intent', createdAt: ageDays(400) },
    { id: 'a-old-2', tenantId: TENANT_A, taskType: 'classify_intent', createdAt: ageDays(390) },
    { id: 'a-old-3', tenantId: TENANT_A, taskType: 'summarize_conversation', createdAt: ageDays(380) },
    { id: 'a-inside', tenantId: TENANT_A, taskType: 'classify_intent', createdAt: ageDays(364) },
    { id: 'b-old-1', tenantId: TENANT_B, taskType: 'draft_estimate', createdAt: ageDays(500) },
    { id: 'b-fresh', tenantId: TENANT_B, taskType: 'draft_estimate', createdAt: ageDays(1) },
    { id: 'p-old-1', tenantId: PLACEHOLDER_TENANT_ID, taskType: 'readiness_probe', createdAt: ageDays(450) },
    { id: 'p-fresh', tenantId: PLACEHOLDER_TENANT_ID, taskType: 'readiness_probe', createdAt: ageDays(2) },
  ];
}

function purgeAudits(repo: FakeRepo): AuditEvent[] {
  return repo.audits.filter((e) => e.eventType === 'shadow_comparison.purged');
}

describe('runShadowComparisonRetentionSweep — the batch loop', () => {
  it('hands the repository the horizon, the tenant limit and the batch bound', async () => {
    const repo = new FakeRepo(seed());
    await runShadowComparisonRetentionSweep({
      repo,
      logger: capturingLogger([]),
      retentionDays: 365,
      now: () => NOW,
    });
    expect(repo.selections).toEqual([
      { now: NOW, retentionDays: 365, limit: SHADOW_COMPARISON_RETENTION_SWEEP_TENANT_LIMIT },
    ]);
    expect(repo.purges.map((p) => p.limit)).toEqual(
      repo.purges.map(() => SHADOW_COMPARISON_RETENTION_SWEEP_BATCH),
    );
    expect(repo.purges.every((p) => p.retentionDays === 365 && p.now === NOW)).toBe(true);
  });

  it('deletes only rows past the window, oldest backlog first, one bounded batch per tenant per sweep', async () => {
    const repo = new FakeRepo(seed());
    const deps = {
      repo,
      logger: capturingLogger([]),
      retentionDays: 365,
      batchSize: 2,
      now: () => NOW,
    };

    const first = await runShadowComparisonRetentionSweep(deps);
    // Tenants are served oldest backlog first: B (500d), placeholder (450d), A (400d).
    expect(repo.purges.map((p) => p.tenantId)).toEqual([TENANT_B, PLACEHOLDER_TENANT_ID, TENANT_A]);
    expect(first).toEqual({ tenantsDue: 3, purged: 4, tenantsFailed: 0 });
    // A's batch of 2 took its two oldest; the third waits for the next sweep.
    expect(repo.rows.map((r) => r.id).sort()).toEqual(['a-inside', 'a-old-3', 'b-fresh', 'p-fresh']);

    const second = await runShadowComparisonRetentionSweep(deps);
    expect(second).toEqual({ tenantsDue: 1, purged: 1, tenantsFailed: 0 });
    expect(repo.rows.map((r) => r.id).sort()).toEqual(['a-inside', 'b-fresh', 'p-fresh']);

    const third = await runShadowComparisonRetentionSweep(deps);
    expect(third).toEqual({ tenantsDue: 0, purged: 0, tenantsFailed: 0 });
  });

  it('a shorter window reaches younger rows (the configured window is the only horizon)', async () => {
    const repo = new FakeRepo(seed());
    const result = await runShadowComparisonRetentionSweep({
      repo,
      logger: capturingLogger([]),
      retentionDays: 30,
      now: () => NOW,
    });
    expect(result.purged).toBe(6);
    expect(repo.rows.map((r) => r.id).sort()).toEqual(['b-fresh', 'p-fresh']);
  });

  it('one tenant failing is logged and counted; the other tenants are still swept', async () => {
    const repo = new FakeRepo(seed());
    repo.failPurgeFor.add(TENANT_B);
    const lines: LoggedLine[] = [];
    const result = await runShadowComparisonRetentionSweep({
      repo,
      logger: capturingLogger(lines),
      retentionDays: 365,
      now: () => NOW,
    });
    expect(result).toEqual({ tenantsDue: 3, purged: 4, tenantsFailed: 1 });
    expect(repo.rows.some((r) => r.id === 'b-old-1')).toBe(true);
    expect(lines).toContainEqual({
      level: 'warn',
      message: 'shadow-comparison retention sweep: purge failed for tenant',
      meta: { tenantId: TENANT_B, error: `purge exploded for ${TENANT_B}` },
    });
  });

  it('a failed tenant selection is logged at error and the sweep returns without throwing', async () => {
    const repo = new FakeRepo(seed());
    repo.failSelection = true;
    const lines: LoggedLine[] = [];
    const result = await runShadowComparisonRetentionSweep({
      repo,
      logger: capturingLogger(lines),
      retentionDays: 365,
      now: () => NOW,
    });
    expect(result).toEqual({ tenantsDue: 0, purged: 0, tenantsFailed: 0 });
    expect(repo.purges).toEqual([]);
    expect(lines).toContainEqual({
      level: 'error',
      message: 'shadow-comparison retention sweep: tenant selection failed',
      meta: { error: 'selection exploded' },
    });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses a retention window of %s rather than deleting everything',
    async (retentionDays) => {
      const repo = new FakeRepo(seed());
      const lines: LoggedLine[] = [];
      const result = await runShadowComparisonRetentionSweep({
        repo,
        logger: capturingLogger(lines),
        retentionDays,
        now: () => NOW,
      });
      expect(result).toEqual({ tenantsDue: 0, purged: 0, tenantsFailed: 0 });
      expect(repo.selections).toEqual([]);
      expect(repo.rows).toHaveLength(seed().length);
      expect(lines.map((l) => l.level)).toEqual(['error']);
    },
  );

  it('writes one audit event per real-tenant batch, none for the placeholder bucket', async () => {
    const repo = new FakeRepo(seed());
    const lines: LoggedLine[] = [];
    await runShadowComparisonRetentionSweep({
      repo,
      logger: capturingLogger(lines),
      retentionDays: 365,
      now: () => NOW,
    });
    // The placeholder's batch is expected to go unaudited: nothing is logged for it.
    expect(lines.filter((l) => l.level !== 'info')).toEqual([]);
    const events = purgeAudits(repo);
    expect(events.map((e) => e.tenantId).sort()).toEqual([TENANT_A, TENANT_B].sort());
    expect(events.some((e) => e.tenantId === PLACEHOLDER_TENANT_ID)).toBe(false);
    const a = events.find((e) => e.tenantId === TENANT_A)!;
    expect(a).toMatchObject({
      actorId: 'shadow-comparison-retention-worker',
      actorRole: 'system',
      entityType: 'tenant',
      entityId: TENANT_A,
      metadata: {
        reason: 'past_retention',
        retentionDays: 365,
        rowsPurged: 3,
        byTaskType: { classify_intent: 2, summarize_conversation: 1 },
        oldestCreatedAt: ageDays(400).toISOString(),
        newestCreatedAt: ageDays(380).toISOString(),
      },
    });
  });

  it('a failed audit write fails its batch: the rows stay for the next sweep and the other tenants go on', async () => {
    const repo = new FakeRepo(seed());
    repo.failAuditFor.add(TENANT_A);
    const lines: LoggedLine[] = [];
    const deps = { repo, logger: capturingLogger(lines), retentionDays: 365, now: () => NOW };

    const result = await runShadowComparisonRetentionSweep(deps);
    // B (1 row) and the placeholder (1 row) are purged; A's 3 rows are kept.
    expect(result).toEqual({ tenantsDue: 3, purged: 2, tenantsFailed: 1 });
    expect(repo.rows.filter((r) => r.tenantId === TENANT_A).map((r) => r.id).sort()).toEqual([
      'a-inside',
      'a-old-1',
      'a-old-2',
      'a-old-3',
    ]);
    expect(purgeAudits(repo).map((e) => e.tenantId)).toEqual([TENANT_B]);
    expect(lines).toContainEqual({
      level: 'warn',
      message: 'shadow-comparison retention sweep: purge failed for tenant',
      meta: { tenantId: TENANT_A, error: `audit insert failed for ${TENANT_A}` },
    });

    // Next sweep, the audit insert works: A's batch goes, with its audit row.
    repo.failAuditFor.clear();
    expect(await runShadowComparisonRetentionSweep(deps)).toEqual({ tenantsDue: 1, purged: 3, tenantsFailed: 0 });
    expect(purgeAudits(repo).find((e) => e.tenantId === TENANT_A)?.metadata?.rowsPurged).toBe(3);
  });

  it("a tenant with no tenants row (a deprovisioned tenant's late sample) is purged unaudited, and that is logged", async () => {
    const repo = new FakeRepo(seed());
    repo.tenantRows.delete(TENANT_B);
    const lines: LoggedLine[] = [];
    const result = await runShadowComparisonRetentionSweep({
      repo,
      logger: capturingLogger(lines),
      retentionDays: 365,
      now: () => NOW,
    });
    expect(result).toEqual({ tenantsDue: 3, purged: 5, tenantsFailed: 0 });
    expect(repo.rows.some((r) => r.id === 'b-old-1')).toBe(false);
    expect(purgeAudits(repo).map((e) => e.tenantId)).toEqual([TENANT_A]);
    expect(lines.filter((l) => l.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: 'shadow-comparison retention sweep: purged rows of a tenant with no tenants row, unaudited',
        meta: { tenantId: TENANT_B, rowsPurged: 1 },
      },
    ]);
  });

  it('logs one completion line with the counts and increments the purge counter', async () => {
    const before = (await shadowComparisonsPurgedTotal.get()).values[0]?.value ?? 0;
    const repo = new FakeRepo(seed());
    const lines: LoggedLine[] = [];
    await runShadowComparisonRetentionSweep({
      repo,
      logger: capturingLogger(lines),
      retentionDays: 365,
      now: () => NOW,
    });
    expect(lines.filter((l) => l.level === 'info')).toEqual([
      {
        level: 'info',
        message: 'shadow-comparison retention sweep completed',
        meta: { retentionDays: 365, tenantsDue: 3, purged: 5, tenantsFailed: 0 },
      },
    ]);
    const after = (await shadowComparisonsPurgedTotal.get()).values[0]?.value ?? 0;
    expect(after - before).toBe(5);
  });
});

describe('summarizePurgedShadowComparisons', () => {
  it('counts per task type (an unset task type under its own key) and brackets the batch', () => {
    expect(
      summarizePurgedShadowComparisons(
        [
          { taskType: 'classify_intent', createdAt: ageDays(380) },
          { taskType: null, createdAt: ageDays(400) },
          { taskType: 'classify_intent', createdAt: ageDays(390) },
        ],
        365,
      ),
    ).toEqual({
      reason: 'past_retention',
      retentionDays: 365,
      rowsPurged: 3,
      byTaskType: { classify_intent: 2, unknown: 1 },
      oldestCreatedAt: ageDays(400).toISOString(),
      newestCreatedAt: ageDays(380).toISOString(),
    });
  });
});
