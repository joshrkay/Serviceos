/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration` (or an
 * EXTERNAL_TEST_DB_URL with the full schema applied).
 *
 * QA-2026-07-10 — inbound-voice proposals dropped on a fabricated ai_run_id.
 *
 * FK-PATH-COVERAGE: src/ai/voice-turn/create-voice-turn-processor.ts
 * FK-PATH-COVERAGE: src/telephony/twilio-adapter.ts
 * FK-PATH-COVERAGE: src/ai/agents/customer-calling/inapp-adapter.ts
 * FK-PATH-COVERAGE: src/proposals/pg-proposal.ts
 *
 * The telephony voice-turn + Twilio-adapter paths built proposals with a
 * random `aiRunId: uuidv4()`. `proposals.ai_run_id` has an FK to
 * `ai_runs(id)`; a random uuid has no matching row, so the INSERT threw
 * `proposals_ai_run_id_fkey`. The error was swallowed, silently dropping
 * EVERY inbound-voice proposal on Postgres. The unit suite uses the
 * in-memory repo, which does NOT enforce the FK — which is exactly why the
 * defect survived. These tests pin the real FK behavior:
 *
 *  1. A proposal with `ai_run_id` OMITTED persists (ai_run_id NULL). This is
 *     the fixed voice path — the proposal is captured, not dropped.
 *  2. A proposal with a fabricated (nonexistent) ai_run_id is REJECTED by
 *     the FK. This reproduces the old bug and proves the constraint is real.
 *  3. A proposal with a REAL ai_runs id persists and round-trips the link.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  getSharedTestDb,
  createTestTenant,
  closeSharedTestDb,
  type TestTenant,
} from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { createProposal } from '../../src/proposals/proposal';

describe('Postgres integration — voice proposal ai_run_id FK (QA-2026-07-10)', () => {
  let pool: Pool;
  let repo: PgProposalRepository;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgProposalRepository(pool);
    tenant = await createTestTenant(pool);
  }, 120_000);

  afterAll(async () => {
    // Clean up only our own rows; the shared DB/schema is left intact.
    await pool.query('DELETE FROM proposals WHERE tenant_id = $1', [
      tenant.tenantId,
    ]);
    await pool.query('DELETE FROM ai_runs WHERE tenant_id = $1', [
      tenant.tenantId,
    ]);
    await closeSharedTestDb();
  });

  it('persists a voice proposal with ai_run_id OMITTED (not dropped)', async () => {
    // Mirrors the fixed telephony create_proposal side effect: no aiRunId
    // is threaded, so createProposal leaves it undefined and the repo
    // inserts NULL. The FK permits NULL — the proposal MUST be captured.
    const built = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'voice_clarification',
      payload: {
        intent: 'customer_callback_required',
        sessionId: 'voice-sess-1',
      },
      summary: 'Customer callback required (rotation_empty)',
      createdBy: 'calling-agent',
    });
    expect(built.aiRunId).toBeUndefined();

    const stored = await repo.create(built);
    expect(stored.id).toBe(built.id);

    const row = await pool.query(
      'SELECT ai_run_id FROM proposals WHERE tenant_id = $1 AND id = $2',
      [tenant.tenantId, stored.id],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].ai_run_id).toBeNull();
  });

  it('REJECTS a proposal with a fabricated ai_run_id (proves the FK is real)', async () => {
    // This is the pre-fix behavior: a random uuid has no ai_runs row, so
    // the INSERT violates proposals_ai_run_id_fkey. If this ever stops
    // throwing, the FK has been dropped and the silent-drop class of bug
    // is back.
    const fabricated = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'voice_clarification',
      payload: { intent: 'customer_callback_required' },
      summary: 'fabricated ai_run_id',
      createdBy: 'calling-agent',
      aiRunId: '00000000-0000-4000-8000-000000000000',
    });

    await expect(repo.create(fabricated)).rejects.toThrow(
      /proposals_ai_run_id_fkey|foreign key/i,
    );
  });

  it('persists a proposal linked to a REAL ai_runs row and round-trips it', async () => {
    const runId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO ai_runs (id, tenant_id, task_type, model, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, tenant.tenantId, 'intent_classification', 'mock-model', 'completed', 'test'],
    );

    const built = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'voice_clarification',
      payload: { intent: 'create_invoice' },
      summary: 'linked to a real run',
      createdBy: 'calling-agent',
      aiRunId: runId,
    });
    const stored = await repo.create(built);
    expect(stored.aiRunId).toBe(runId);

    const linked = await repo.findByAiRun(tenant.tenantId, runId);
    expect(linked.map((p) => p.id)).toContain(stored.id);
  });
});
