/**
 * PRIV-1 (PRIVACY/RETENTION) — `ai_runs` must lose its prompt and reply
 * content once the run is past the tenant's `recording_retention_days`.
 *
 * Every LLMGateway.complete writes the request messages to
 * `ai_runs.input_snapshot` and the reply to `output_snapshot.content`. The
 * classify_intent request carries the caller's words and the
 * summarize_conversation request carries every line of the call, so the C6
 * sweep (which purges the transcript, turns, summary, embeddings and session
 * transcript) left the biggest copy of the call behind, forever.
 *
 * The rows are KEPT: proposals.ai_run_id (and supervisor_reviews,
 * document_revisions, estimate_provenance) FK them, and the spend report
 * reads their model / tokens / cost.
 *
 * Every assertion runs the PRODUCTION sweep against the PRODUCTION
 * repository at real Postgres with RLS_RUNTIME_ROLE on. Runs are written by
 * the product writers: the real LLMGateway (stub provider, the LLM seam) over
 * PgAiRunRepository, and the supervisor reviewer's direct createAiRun shape.
 * SQL fixtures only for what no product surface can produce:
 * `recording_retention_days`, aging `created_at` (the clock, never the
 * content), and a proposal row pointing at a run.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  closeSharedTestDb,
  createTestTenant,
  getSharedTestDb,
  type TestTenant,
} from './shared';
import { LLMGateway, type LLMProvider, type LLMResponse } from '../../src/ai/gateway/gateway';
import { PgAiRunRepository } from '../../src/ai/pg-ai-run';
import { createAiRun } from '../../src/ai/ai-run';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { DevStorageProvider } from '../../src/files/storage-provider';
import {
  PgRecordingRetentionRepository,
  runRecordingRetentionSweep,
  type RecordingRetentionSweepResult,
} from '../../src/workers/recording-retention-worker';
import type { Logger } from '../../src/logging/logger';

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

const CALLER_LINE = 'caller: this is Maria Lopez at 14 Elm Street, call me on 555-201-7788';
const SUMMARY_REPLY =
  '{"summary":"Maria Lopez (14 Elm Street, 555-201-7788) reported a banging furnace."}';

let pool: Pool;
let aiRunRepo: PgAiRunRepository;
let auditRepo: PgAuditRepository;
let gateway: LLMGateway;
const storage = new DevStorageProvider({
  bucket: 'dev',
  publicUrlBase: 'http://localhost:3000/storage-dev',
});

beforeAll(async () => {
  pool = await getSharedTestDb();
  aiRunRepo = new PgAiRunRepository(pool);
  auditRepo = new PgAuditRepository(pool);
  const provider: LLMProvider = {
    name: 'stub',
    isAvailable: async () => true,
    complete: async (): Promise<LLMResponse> => ({
      content: SUMMARY_REPLY,
      model: 'gpt-4o-mini',
      provider: 'openai',
      tokenUsage: { input: 120, output: 40, total: 160 },
      latencyMs: 0,
    }),
  };
  gateway = new LLMGateway(
    { defaultProvider: 'stub' },
    new Map([['stub', provider]]),
    undefined,
    aiRunRepo,
  );
});

afterAll(async () => {
  await closeSharedTestDb();
});

async function seedTenant(retentionDays: number): Promise<TestTenant> {
  const t = await createTestTenant(pool);
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, recording_retention_days)
     VALUES (gen_random_uuid(), $1, $2, $3)`,
    [t.tenantId, `Retention ${retentionDays}d Co`, retentionDays],
  );
  return t;
}

/** A call summary run exactly as summarizeSession sends it, aged by `ageHours`. */
async function seedSummaryRun(t: TestTenant, ageHours: number): Promise<string> {
  const response = await gateway.complete({
    taskType: 'summarize_conversation',
    tenantId: t.tenantId,
    messages: [{ role: 'user', content: `${CALLER_LINE}\n\nagent: booking you in for Thursday` }],
    responseFormat: 'json',
    temperature: 0.2,
    metadata: { tenantId: t.tenantId, sessionId: crypto.randomUUID() },
  });
  expect(response.aiRunId).toBeDefined();
  await age(t, response.aiRunId!, ageHours);
  return response.aiRunId!;
}

/** A supervisor review run (reviewer.ts writes its own row, not through the gateway). */
async function seedSupervisorRun(t: TestTenant, ageHours: number): Promise<string> {
  const run = createAiRun({
    tenantId: t.tenantId,
    taskType: 'supervisor_review',
    model: 'gpt-4o-mini',
    inputSnapshot: { proposalType: 'create_appointment', summary: 'Book Maria Lopez at 14 Elm Street' },
    createdBy: 'system',
  });
  await aiRunRepo.create(run);
  await aiRunRepo.updateStatus(t.tenantId, run.id, 'completed', {
    outputSnapshot: { missedUrgency: false, rationale: 'Maria Lopez sounded calm' },
  });
  await age(t, run.id, ageHours);
  return run.id;
}

async function age(t: TestTenant, id: string, ageHours: number): Promise<void> {
  // Fixture clock only.
  await pool.query(
    `UPDATE ai_runs SET created_at = now() - make_interval(hours => $3)
      WHERE tenant_id = $1 AND id = $2`,
    [t.tenantId, id, ageHours],
  );
}

async function linkProposal(t: TestTenant, aiRunId: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO proposals (tenant_id, proposal_type, status, payload, ai_run_id, idempotency_key, created_by)
     VALUES ($1, 'create_appointment', 'ready_for_review', '{}'::jsonb, $2, $3, 'voice-agent')
     RETURNING id`,
    [t.tenantId, aiRunId, `priv1-${crypto.randomUUID()}`],
  );
  return String(rows[0].id);
}

interface RunRow {
  input_snapshot: Record<string, unknown>;
  output_snapshot: Record<string, unknown> | null;
  status: string;
  model: string;
  task_type: string;
  token_usage: Record<string, unknown> | null;
  content_purged_at: Date | null;
}

async function runRow(tenantId: string, id: string): Promise<RunRow | undefined> {
  const { rows } = await pool.query(
    `SELECT input_snapshot, output_snapshot, status, model, task_type, token_usage, content_purged_at
       FROM ai_runs WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0];
}

async function purgeEvents(tenantId: string) {
  const events = await auditRepo.findByEntity(tenantId, 'tenant', tenantId);
  return events.filter((e) => e.eventType === 'ai_run.content_purged');
}

describe('PRIV-1 — the retention sweep purges ai_runs prompt and reply content past the tenant horizon (real Postgres)', () => {
  let tenantA: TestTenant; // 1-day retention
  let tenantB: TestTenant; // 365-day retention
  let oldA: string;
  let oldSupervisorA: string;
  let freshA: string;
  let oldB: string;
  let proposalId: string;
  let result: RecordingRetentionSweepResult;
  const lines: LoggedLine[] = [];

  beforeAll(async () => {
    tenantA = await seedTenant(1);
    tenantB = await seedTenant(365);
    oldA = await seedSummaryRun(tenantA, 48);
    oldSupervisorA = await seedSupervisorRun(tenantA, 50);
    freshA = await seedSummaryRun(tenantA, 1);
    oldB = await seedSummaryRun(tenantB, 48);
    proposalId = await linkProposal(tenantA, oldA);

    // Sanity: the product writer really did store the caller's words.
    expect(JSON.stringify((await runRow(tenantA.tenantId, oldA))!.input_snapshot)).toContain('Maria Lopez');

    result = await runRecordingRetentionSweep({
      repo: new PgRecordingRetentionRepository(pool),
      storage,
      auditRepo,
      logger: capturingLogger(lines),
    });
  });

  it("strips the messages and the reply from tenant A's 2-day-old run; the row and its accounting columns are kept", async () => {
    const row = (await runRow(tenantA.tenantId, oldA))!;
    expect(row).toBeDefined();
    const stored = JSON.stringify([row.input_snapshot, row.output_snapshot]);
    expect(stored).not.toContain('Maria Lopez');
    expect(stored).not.toContain('Elm Street');
    expect(stored).not.toContain('555-201-7788');
    expect(row.input_snapshot).toEqual({ temperature: 0.2 });
    expect(row.output_snapshot).toEqual({ provider: 'openai' });
    expect(row.content_purged_at).toBeInstanceOf(Date);
    expect(row).toMatchObject({
      status: 'completed',
      model: 'gpt-4o-mini',
      task_type: 'summarize_conversation',
      token_usage: { input: 120, output: 40, total: 160 },
    });
  });

  it('keeps the proposal that points at the purged run (FK intact)', async () => {
    const { rows } = await pool.query(
      `SELECT p.ai_run_id, r.id AS run_id
         FROM proposals p JOIN ai_runs r ON r.id = p.ai_run_id
        WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenantA.tenantId, proposalId],
    );
    expect(rows).toEqual([{ ai_run_id: oldA, run_id: oldA }]);
  });

  it('scrubs every task type: a supervisor review run written outside the gateway loses its summary and rationale', async () => {
    const row = (await runRow(tenantA.tenantId, oldSupervisorA))!;
    expect(row.input_snapshot).toEqual({});
    expect(row.output_snapshot).toEqual({});
    expect(row.content_purged_at).toBeInstanceOf(Date);
  });

  it("keeps tenant A's 1-hour-old run untouched (inside the horizon)", async () => {
    const row = (await runRow(tenantA.tenantId, freshA))!;
    expect(JSON.stringify(row.input_snapshot)).toContain('Maria Lopez');
    expect(row.output_snapshot).toMatchObject({ content: SUMMARY_REPLY });
    expect(row.content_purged_at).toBeNull();
  });

  it("keeps tenant B's 2-day-old run untouched (365-day retention)", async () => {
    const row = (await runRow(tenantB.tenantId, oldB))!;
    expect(JSON.stringify(row.input_snapshot)).toContain('Maria Lopez');
    expect(row.output_snapshot).toMatchObject({ content: SUMMARY_REPLY });
    expect(row.content_purged_at).toBeNull();
  });

  it('counts the purge in the sweep result and the completion log', async () => {
    expect(result.aiRunContentPurged).toBeGreaterThanOrEqual(2);
    expect(result.aiRunContentTenantsFailed).toBe(0);
    const completed = lines.find((l) => l.message === 'recording-retention sweep completed');
    expect(completed?.meta?.aiRunContentPurged).toBe(result.aiRunContentPurged);
  });

  it('writes ONE system audit event for the tenant batch, and none for tenant B', async () => {
    const events = await purgeEvents(tenantA.tenantId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: tenantA.tenantId,
      actorId: 'recording-retention-worker',
      actorRole: 'system',
      eventType: 'ai_run.content_purged',
      entityType: 'tenant',
      entityId: tenantA.tenantId,
    });
    expect(events[0].metadata).toMatchObject({
      reason: 'past_retention',
      runsPurged: 2,
      byTaskType: { summarize_conversation: 1, supervisor_review: 1 },
    });
    expect(await purgeEvents(tenantB.tenantId)).toEqual([]);
  });

  it('is idempotent: a second sweep purges nothing more for tenant A and writes no new audit', async () => {
    await runRecordingRetentionSweep({
      repo: new PgRecordingRetentionRepository(pool),
      storage,
      auditRepo,
      logger: capturingLogger([]),
    });
    expect(await purgeEvents(tenantA.tenantId)).toHaveLength(1);
    expect((await runRow(tenantA.tenantId, freshA))!.content_purged_at).toBeNull();
  });
});

describe("PRIV-1 — one tenant's failed purge does not stop the rest (real selector, real Postgres failure)", () => {
  class VisitOrderRepo extends PgRecordingRetentionRepository {
    public visited: string[] = [];
    override async purgeAiRunContent(
      ...args: Parameters<PgRecordingRetentionRepository['purgeAiRunContent']>
    ): ReturnType<PgRecordingRetentionRepository['purgeAiRunContent']> {
      this.visited.push(args[0]);
      return super.purgeAiRunContent(...args);
    }
  }

  it('a tenant whose UPDATE raises in Postgres is rolled back and logged; tenant C is still purged in the same sweep', async () => {
    const doomed = await seedTenant(1);
    const tenantC = await seedTenant(1);
    // Older than tenant C's so the oldest-first selector reaches it first.
    const doomedRun = await seedSummaryRun(doomed, 24 * 40);
    const runC = await seedSummaryRun(tenantC, 24 * 30);

    await pool.query(`
      CREATE OR REPLACE FUNCTION test_priv1_fail_update() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'test_priv1: simulated update failure for tenant %', OLD.tenant_id;
      END
      $fn$`);
    await pool.query(`
      CREATE TRIGGER test_priv1_fail_update
        BEFORE UPDATE ON ai_runs
        FOR EACH ROW WHEN (OLD.tenant_id = '${doomed.tenantId}'::uuid)
        EXECUTE FUNCTION test_priv1_fail_update()`);

    const repo = new VisitOrderRepo(pool);
    const lines: LoggedLine[] = [];
    let result: RecordingRetentionSweepResult;
    try {
      result = await runRecordingRetentionSweep({
        repo,
        storage,
        auditRepo,
        logger: capturingLogger(lines),
      });
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS test_priv1_fail_update ON ai_runs`);
      await pool.query(`DROP FUNCTION IF EXISTS test_priv1_fail_update()`);
    }

    const doomedAt = repo.visited.indexOf(doomed.tenantId);
    const survivorAt = repo.visited.indexOf(tenantC.tenantId);
    expect(doomedAt).toBeGreaterThanOrEqual(0);
    expect(survivorAt).toBeGreaterThan(doomedAt);

    expect(JSON.stringify((await runRow(doomed.tenantId, doomedRun))!.input_snapshot)).toContain('Maria Lopez');
    expect(result!.aiRunContentTenantsFailed).toBeGreaterThanOrEqual(1);
    const warn = lines.find((l) => l.level === 'warn' && l.meta?.tenantId === doomed.tenantId);
    expect(String(warn?.meta?.error)).toContain('test_priv1: simulated update failure');
    expect(await purgeEvents(doomed.tenantId)).toEqual([]);

    expect((await runRow(tenantC.tenantId, runC))!.content_purged_at).toBeInstanceOf(Date);
    expect(await purgeEvents(tenantC.tenantId)).toHaveLength(1);
  });
});

describe('PRIV-1 — bounded batches (real Postgres)', () => {
  it('purges at most the per-tenant batch per sweep, oldest first; the remainder goes on the next sweep', async () => {
    const t = await seedTenant(1);
    const r1 = await seedSummaryRun(t, 24 * 5);
    const r2 = await seedSummaryRun(t, 24 * 3);
    const repo = new PgRecordingRetentionRepository(pool);
    const logger = capturingLogger([]);

    await runRecordingRetentionSweep({ repo, storage, auditRepo, logger, aiRunContentBatchSize: 1 });
    expect((await runRow(t.tenantId, r1))!.content_purged_at).toBeInstanceOf(Date);
    expect((await runRow(t.tenantId, r2))!.content_purged_at).toBeNull();

    await runRecordingRetentionSweep({ repo, storage, auditRepo, logger, aiRunContentBatchSize: 1 });
    expect((await runRow(t.tenantId, r2))!.content_purged_at).toBeInstanceOf(Date);
    // One audit event per tenant batch: two sweeps, two batches.
    const events = await purgeEvents(t.tenantId);
    expect(events.map((e) => e.metadata?.runsPurged)).toEqual([1, 1]);
  });
});
