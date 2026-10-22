/**
 * OBS-1 — Docker-gated integration: a brand-voice generation leaves exactly one
 * completed ai_runs row in REAL Postgres.
 *
 * The composer tags its gateway call with metadata.promptVersionId =
 * 'brand_voice_v1'. The gateway bound that into ai_runs.prompt_version_id, a
 * UUID column, so Postgres rejected the INSERT ("invalid input syntax for type
 * uuid") and the gateway's best-effort logging swallowed it: every brand-voice
 * completion — the dropped-call recovery SMS, the tech-out reschedule draft,
 * the daily digest — left no record of input, model, tokens or cost. Unit
 * tests with an in-memory repo could not see it (CLAUDE.md: a mocked DB is
 * never the only proof a query works), so this drives the real LLMGateway +
 * PgAiRunRepository + composeBrandVoiceMessage with only the provider stubbed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgAiRunRepository } from '../../src/ai/pg-ai-run';
import { createAiRun } from '../../src/ai/ai-run';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest, LLMGatewayLogger } from '../../src/ai/gateway/gateway';
import { composeBrandVoiceMessage } from '../../src/ai/brand-voice/composer';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings } from '../../src/settings/settings';
import { BRAND_VOICE_TASK_TYPE, BRAND_VOICE_PROMPT_VERSION_ID } from '../../src/ai/prompt-registry';

describe('Postgres integration — brand-voice completions are recorded in ai_runs (OBS-1)', () => {
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

  it('composeBrandVoiceMessage through the real gateway writes ONE completed brand_voice_v1 row', async () => {
    const requests: LLMRequest[] = [];
    const provider: LLMProvider = {
      name: 'stub',
      isAvailable: async () => true,
      complete: async (req) => {
        requests.push(req);
        return {
          content: 'Hi Jane — your tech is running late; can we move you to 3pm tomorrow?',
          // A priced model, so cost_micro_cents must be set.
          model: 'claude-haiku-4-5-20251001',
          provider: 'stub',
          tokenUsage: { input: 220, output: 30, total: 250 },
          latencyMs: 5,
        };
      },
    };
    const loggedErrors: string[] = [];
    const logger: LLMGatewayLogger = {
      info: () => undefined,
      error: (message, meta) => loggedErrors.push(`${message} ${JSON.stringify(meta ?? {})}`),
    };
    const gateway = new LLMGateway(
      { defaultProvider: 'stub' },
      new Map([['stub', provider]]),
      logger,
      repo,
    );
    const settingsRepo = new PgSettingsRepository(pool);
    await ensureTenantSettings(tenant.tenantId, settingsRepo);

    const result = await composeBrandVoiceMessage(
      {
        tenantId: tenant.tenantId,
        intent: 'tech_reschedule_customer_sms',
        context: { customerName: 'Jane', technicianName: 'Sam', reason: 'running late' },
        maxChars: 320,
      },
      { gateway, settingsRepo },
    );

    expect(result.text.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    expect(loggedErrors.filter((e) => e.includes('AI-run'))).toEqual([]);

    const { rows } = await pool.query(
      `SELECT task_type, status, model, prompt_version_id, cost_micro_cents,
              token_usage, input_snapshot, output_snapshot
         FROM ai_runs WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.task_type).toBe(BRAND_VOICE_TASK_TYPE);
    expect(row.status).toBe('completed');
    expect(row.model).toBe('claude-haiku-4-5-20251001');
    expect(row.prompt_version_id).toBeNull();
    // claude-haiku-4-5: 100 cents/M in, 500 cents/M out.
    expect(Number(row.cost_micro_cents)).toBe(220 * 100 + 30 * 500);
    expect(row.token_usage).toMatchObject({ input: 220, output: 30, total: 250 });
    expect(row.input_snapshot.promptRef).toBe(BRAND_VOICE_PROMPT_VERSION_ID);
    expect(row.output_snapshot.content).toContain('3pm');
  });

  it('PgAiRunRepository.create never binds a non-UUID into the UUID column', async () => {
    const run = createAiRun({
      tenantId: tenant.tenantId,
      taskType: 'brand_voice_v1',
      model: 'claude-haiku-4-5-20251001',
      promptVersionId: 'brand_voice_v1',
      inputSnapshot: { messages: [] },
      createdBy: 'test',
    });
    const created = await repo.create(run);
    expect(created.id).toBe(run.id);
    expect(created.promptVersionId).toBeUndefined();
  });

  it('PgAiRunRepository.create still persists a real UUID prompt version', async () => {
    const promptVersionId = crypto.randomUUID();
    const run = createAiRun({
      tenantId: tenant.tenantId,
      taskType: 'summarize_conversation',
      model: 'claude-haiku-4-5-20251001',
      promptVersionId,
      inputSnapshot: { messages: [] },
      createdBy: 'test',
    });
    const created = await repo.create(run);
    expect(created.promptVersionId).toBe(promptVersionId);
  });
});
