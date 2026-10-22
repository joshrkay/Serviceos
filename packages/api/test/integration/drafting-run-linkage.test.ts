/**
 * OBS-2 — an AI-drafted proposal joins to the model run that authored it, and
 * that run is findable from the conversation, against real Postgres.
 *
 * Before: drafting handlers passed no gateway metadata (ai_runs.correlation_id
 * was a random uuid — no key back to the conversation) and set no aiRunId
 * (proposals.ai_run_id NULL for every chat- and memo-drafted proposal).
 *
 * Drives the real EstimateTaskHandler through a real LLMGateway wired with
 * PgAiRunRepository (so the completion writes an ai_runs row and returns its
 * id), persists through PgProposalRepository (the FK proposals.ai_run_id →
 * ai_runs(id) is enforced), and proves:
 *   - the persisted proposal's ai_run_id resolves to that ai_runs row;
 *   - the row's correlation_id is the conversation id, so "every AI run on
 *     this conversation" is one indexed-column query, not a timestamp guess;
 *   - a second tenant's query finds nothing (tenant-scoped).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAiRunRepository } from '../../src/ai/pg-ai-run';
import { LLMGateway, type LLMProvider, type LLMRequest, type LLMResponse } from '../../src/ai/gateway/gateway';
import { EstimateTaskHandler } from '../../src/ai/tasks/estimate-task';

describe('OBS-2 — proposals.ai_run_id → the drafting run, keyed to the conversation (Postgres)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
  });

  function gateway(): LLMGateway {
    const provider: LLMProvider = {
      name: 'stub',
      isAvailable: async () => true,
      complete: async (_req: LLMRequest): Promise<LLMResponse> => ({
        content: JSON.stringify({
          lineItems: [{ description: 'Capacitor replacement', quantity: 1, unitPrice: 18900 }],
          confidence_score: 0.8,
        }),
        model: 'stub-model',
        provider: 'stub',
        tokenUsage: { input: 10, output: 5, total: 15 },
        latencyMs: 1,
      }),
    };
    return new LLMGateway(
      { defaultProvider: 'stub' },
      new Map([['stub', provider]]),
      undefined,
      new PgAiRunRepository(pool),
    );
  }

  it('the persisted proposal joins to its drafting run, whose correlation_id is the conversation', async () => {
    const conversationId = crypto.randomUUID();
    const { proposal } = await new EstimateTaskHandler(gateway()).handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Quote a capacitor replacement',
      conversationId,
      customerId: crypto.randomUUID(),
    });
    expect(proposal.aiRunId).toBeDefined();

    // The FK is enforced here: a made-up id would make this insert throw.
    await new PgProposalRepository(pool).create(proposal);

    const { rows } = await pool.query(
      `SELECT r.id, r.task_type, r.correlation_id
         FROM proposals p JOIN ai_runs r ON r.id = p.ai_run_id
        WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenant.tenantId, proposal.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].task_type).toBe('draft_estimate');
    expect(rows[0].correlation_id).toBe(conversationId);

    // "Every AI run on this conversation" — one keyed query.
    const { rows: onConversation } = await pool.query(
      `SELECT id FROM ai_runs WHERE tenant_id = $1 AND correlation_id = $2`,
      [tenant.tenantId, conversationId],
    );
    expect(onConversation.map((r) => r.id)).toEqual([proposal.aiRunId]);

    const other = await createTestTenant(pool);
    const { rows: foreign } = await pool.query(
      `SELECT id FROM ai_runs WHERE tenant_id = $1 AND correlation_id = $2`,
      [other.tenantId, conversationId],
    );
    expect(foreign).toEqual([]);
  });
});
