/**
 * B1.18 (rivet-voice-19) — "Set my brand voice: friendly, plain-spoken, no
 * slang, always sign off 'Thanks — Bob's HVAC'" against REAL Postgres.
 *
 * Drives the TASK-PRODUCED payload (never a hand-built one) through the real
 * approval gate and the production execution registry, proving the whole
 * chain: utterance → task draft → approve → UpdateBrandVoiceExecutionHandler
 * → updateBrandVoice (the SAME versioned path the Brand-Voice Configurator
 * sheet uses) → brand_voice_versions row + brand_voice.updated audit event.
 * Also proves the cool-down surfaces as an honest execution_failed reason
 * (never a silent skip) and that a cross-tenant reader sees nothing.
 *
 * Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgBrandVoiceRepository } from '../../src/tenants/brand/pg-brand-voice-repository';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings } from '../../src/settings/settings';
import { missingFieldsFor, Proposal } from '../../src/proposals/proposal';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { approveProposal } from '../../src/proposals/actions';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { UpdateBrandVoiceTaskHandler } from '../../src/ai/tasks/brand-voice-task';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: async () =>
      ({
        content: jsonContent,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 100, output: 60, total: 160 },
        latencyMs: 12,
      }) satisfies LLMResponse,
  } as unknown as LLMGateway;
}

describe('Postgres integration — voice update_brand_voice → approve → execute → persist + audit', () => {
  let pool: Pool;
  let auditRepo: PgAuditRepository;
  let brandVoiceRepo: PgBrandVoiceRepository;
  let settingsRepo: PgSettingsRepository;
  let proposalRepo: PgProposalRepository;
  let executor: ProposalExecutor;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
    brandVoiceRepo = new PgBrandVoiceRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    tenant = await createTestTenant(pool);
    await ensureTenantSettings(tenant.tenantId, settingsRepo);

    const registry = createExecutionHandlerRegistry({ brandVoiceRepo, auditRepo });
    const guard = new IdempotencyGuard(new PgProposalExecutionRepository(pool), proposalRepo);
    executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    // 1) Draft via the REAL task handler.
    const taskContext: TaskContext = {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message:
        "Set my brand voice: friendly, plain-spoken, no slang, always sign off 'Thanks — Bob's HVAC'",
      existingEntities: {
        brandVoiceInstruction:
          "friendly, plain-spoken, no slang, always sign off 'Thanks — Bob's HVAC'",
      },
    };
    const gateway = mockGateway(
      JSON.stringify({
        register: 'friendly',
        signoff: "Thanks — Bob's HVAC",
        unmapped: 'no slang',
        confidence_score: 0.9,
      }),
    );
    const { proposal: drafted } = await new UpdateBrandVoiceTaskHandler(gateway).handle(taskContext);

    expect(drafted.proposalType).toBe('update_brand_voice');
    expect(drafted.payload.register).toBe('friendly');
    expect(missingFieldsFor(drafted)).toEqual([]);
    expect(drafted.status).toBe('draft'); // manual action class — never auto-approved

    await proposalRepo.create(drafted);

    // 2) The real approval gate lets it through (a human tap).
    const approved: Proposal = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      drafted.id,
      tenant.userId,
      'owner',
      auditRepo,
      'ui',
    );
    expect(approved.status).toBe('approved');

    // 3) Execute past the undo window via the production registry.
    const backdated: Proposal = {
      ...approved,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };
    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(backdated, context);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(tenant.tenantId);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a new brand_voice_versions row with the spoken register + sign-off, version incremented', async () => {
    const state = await brandVoiceRepo.getState(tenant.tenantId);
    expect(state.version).toBe(1);
    expect(state.config.register).toBe('friendly');
    expect(state.config.signoff).toBe("Thanks — Bob's HVAC");

    const versions = await brandVoiceRepo.listVersions(tenant.tenantId);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].changeReason).toBe('web_edit'); // a spoken edit is a normal edit, not onboarding
    expect(versions[0].snapshot.register).toBe('friendly');
  });

  it('emits exactly one brand_voice.updated audit event with actor attribution', async () => {
    const events = await auditRepo.findByEntity(tenant.tenantId, 'brand_voice', tenant.tenantId);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('brand_voice.updated');
    expect(events[0].actorId).toBe(tenant.userId);
  });

  it('does not expose the brand voice to another tenant (scoped read)', async () => {
    const other = await createTestTenant(pool);
    const otherState = await brandVoiceRepo.getState(other.tenantId);
    expect(otherState.version).toBe(0);
    expect(otherState.config.register).toBeUndefined();
    const otherVersions = await brandVoiceRepo.listVersions(other.tenantId);
    expect(otherVersions).toHaveLength(0);
  });

  it('a second voice-approved edit inside the cool-down honestly fails execution — never a silent skip', async () => {
    const registry = createExecutionHandlerRegistry({ brandVoiceRepo, auditRepo });
    const guard = new IdempotencyGuard(new PgProposalExecutionRepository(pool), proposalRepo);
    const secondExecutor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    const taskContext: TaskContext = {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Make our tone more formal',
      existingEntities: { brandVoiceInstruction: 'make our tone more formal' },
    };
    const gateway = mockGateway(JSON.stringify({ register: 'formal', confidence_score: 0.9 }));
    const { proposal: drafted } = await new UpdateBrandVoiceTaskHandler(gateway).handle(taskContext);
    await proposalRepo.create(drafted);

    const approved = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      drafted.id,
      tenant.userId,
      'owner',
      auditRepo,
      'ui',
    );
    const backdated: Proposal = {
      ...approved,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };
    const { result } = await secondExecutor.execute(backdated, {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^brand_voice_cooldown:/);

    // Never a silent skip: still version 1, exactly one audit event total.
    const state = await brandVoiceRepo.getState(tenant.tenantId);
    expect(state.version).toBe(1);
    const events = await auditRepo.findByEntity(tenant.tenantId, 'brand_voice', tenant.tenantId);
    expect(events).toHaveLength(1);
  });
});
