/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration` (or an
 * EXTERNAL_TEST_DB_URL with the full schema applied).
 *
 * Migration 254 adds `ai_runs.cost_micro_cents` (nullable BIGINT). The unit
 * suite exercises `PgAiRunRepository` against a real `pg.Pool` mock, but per
 * CLAUDE.md's testing rule ("tests that mock the DB are never the only proof
 * a query works"), this pins the column against a REAL Postgres: the exact
 * column name/type, the BIGINT-as-string-from-pg coercion in `mapRow`, and
 * the create/update NULL-vs-omitted semantics that unit tests with a mocked
 * `Pool` can't catch (the entity resolver's nonexistent-column defect this
 * rule exists to prevent shipped exactly this way).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgAiRunRepository } from '../../src/ai/pg-ai-run';
import { createAiRun, completeAiRun, type AiRun } from '../../src/ai/ai-run';

describe('Postgres integration — ai_runs.cost_micro_cents (migration 254)', () => {
  let pool: Pool;
  let repo: PgAiRunRepository;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgAiRunRepository(pool);
    tenant = await createTestTenant(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.query('DELETE FROM ai_runs WHERE tenant_id = $1', [tenant.tenantId]);
    await closeSharedTestDb();
  });

  it('column exists as a nullable BIGINT', async () => {
    const { rows } = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'ai_runs' AND column_name = 'cost_micro_cents'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('bigint');
    expect(rows[0].is_nullable).toBe('YES');
  });

  it('persists a known cost on create() and round-trips it as a JS number', async () => {
    const run: AiRun = {
      ...createAiRun({
        tenantId: tenant.tenantId,
        taskType: 'summarize_conversation',
        model: 'claude-sonnet-4-6',
        inputSnapshot: { messages: [] },
        createdBy: 'test',
      }),
      costMicroCents: 450_000,
    };
    const created = await repo.create(run);
    // pg returns BIGINT as a string by default (avoids silent precision
    // loss); mapRow must coerce it back to a number for values well within
    // Number.MAX_SAFE_INTEGER (any realistic cost is nowhere close to that
    // range — this is the exact defect class the FK-mock test rule guards
    // against: a mocked Pool would never surface the string-vs-number gap).
    expect(created.costMicroCents).toBe(450_000);
    expect(typeof created.costMicroCents).toBe('number');

    const found = await repo.findById(tenant.tenantId, run.id);
    expect(found?.costMicroCents).toBe(450_000);
  });

  it('persists NULL for an unpriced model on create() — never a fabricated cost', async () => {
    const run: AiRun = {
      ...createAiRun({
        tenantId: tenant.tenantId,
        taskType: 'summarize_conversation',
        model: 'gpt-4o-mini',
        inputSnapshot: { messages: [] },
        createdBy: 'test',
      }),
      costMicroCents: null,
    };
    const created = await repo.create(run);
    expect(created.costMicroCents).toBeUndefined(); // mapRow: SQL NULL -> undefined

    const { rows } = await pool.query(
      'SELECT cost_micro_cents FROM ai_runs WHERE tenant_id = $1 AND id = $2',
      [tenant.tenantId, run.id],
    );
    expect(rows[0].cost_micro_cents).toBeNull();
  });

  it('updateStatus() sets cost_micro_cents when completing a run', async () => {
    const pending = createAiRun({
      tenantId: tenant.tenantId,
      taskType: 'classify_intent',
      model: 'claude-haiku-4-5-20251001',
      inputSnapshot: { messages: [] },
      createdBy: 'test',
    });
    await repo.create(pending);

    const completed = completeAiRun(pending, { content: 'ok' }, { input: 1, output: 1, total: 2 }, 200);
    const updated = await repo.updateStatus(tenant.tenantId, pending.id, 'completed', {
      outputSnapshot: completed.outputSnapshot,
      tokenUsage: completed.tokenUsage,
      completedAt: completed.completedAt,
      durationMs: completed.durationMs,
      costMicroCents: 200,
    });

    expect(updated?.costMicroCents).toBe(200);
  });

  it('updateStatus() distinguishes "costMicroCents omitted" from "costMicroCents: null"', async () => {
    const pending = createAiRun({
      tenantId: tenant.tenantId,
      taskType: 'classify_intent',
      model: 'claude-haiku-4-5-20251001',
      inputSnapshot: { messages: [] },
      createdBy: 'test',
    });
    await repo.create(pending);

    // Step 1: set a cost.
    await repo.updateStatus(tenant.tenantId, pending.id, 'running', {});
    await repo.updateStatus(tenant.tenantId, pending.id, 'completed', {
      tokenUsage: { input: 1, output: 1, total: 2 },
      costMicroCents: 500,
    });

    // Step 2: an update that OMITS costMicroCents entirely must leave the
    // existing value alone (this is why the repo uses a presence-flag CASE
    // instead of COALESCE — COALESCE can't tell "field absent" from
    // "field present and null").
    const afterOmittedUpdate = await repo.updateStatus(tenant.tenantId, pending.id, 'completed', {
      error: undefined,
    });
    expect(afterOmittedUpdate?.costMicroCents).toBe(500);

    // Step 3: an update that explicitly passes costMicroCents: null clears it.
    const afterExplicitNull = await repo.updateStatus(tenant.tenantId, pending.id, 'completed', {
      costMicroCents: null,
    });
    expect(afterExplicitNull?.costMicroCents).toBeUndefined();
  });

  it('updateStatus() overwrites model on a failover — the resolved-route model at create() is replaced by the actually-served model', async () => {
    // Row is created with the resolved route (Sonnet). A Sonnet -> Haiku
    // failover means costMicroCents ends up priced at Haiku's rates; the
    // completion update must also overwrite `model` so the row's model and
    // cost columns agree — a mocked Pool can't catch a wrong real column
    // name here (CLAUDE.md's testing rule this file exists to satisfy).
    const pending = createAiRun({
      tenantId: tenant.tenantId,
      taskType: 'summarize_conversation',
      model: 'claude-sonnet-4-6',
      inputSnapshot: { messages: [] },
      createdBy: 'test',
    });
    await repo.create(pending);

    const completed = completeAiRun(
      pending,
      { content: 'ok' },
      { input: 500, output: 200, total: 700 },
      150_000,
    );
    const updated = await repo.updateStatus(tenant.tenantId, pending.id, 'completed', {
      outputSnapshot: completed.outputSnapshot,
      tokenUsage: completed.tokenUsage,
      completedAt: completed.completedAt,
      durationMs: completed.durationMs,
      costMicroCents: 150_000,
      model: 'claude-haiku-4-5-20251001',
    });

    expect(updated?.model).toBe('claude-haiku-4-5-20251001');
    expect(updated?.costMicroCents).toBe(150_000);

    const { rows } = await pool.query(
      'SELECT model FROM ai_runs WHERE tenant_id = $1 AND id = $2',
      [tenant.tenantId, pending.id],
    );
    expect(rows[0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('updateStatus() omitting model leaves the existing column value alone', async () => {
    const pending = createAiRun({
      tenantId: tenant.tenantId,
      taskType: 'summarize_conversation',
      model: 'claude-sonnet-4-6',
      inputSnapshot: { messages: [] },
      createdBy: 'test',
    });
    await repo.create(pending);

    const updated = await repo.updateStatus(tenant.tenantId, pending.id, 'completed', {
      costMicroCents: 450_000,
    });

    expect(updated?.model).toBe('claude-sonnet-4-6');
  });
});
