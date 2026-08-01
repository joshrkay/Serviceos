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
import { createProposal, missingFieldsFor, Proposal } from '../../src/proposals/proposal';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { approveProposal, editProposal } from '../../src/proposals/actions';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { UpdateBrandVoiceTaskHandler } from '../../src/ai/tasks/brand-voice-task';
import { runExecutionSweep } from '../../src/workers/execution-worker';
import { createLogger } from '../../src/logging/logger';
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
    // This utterance is genuinely MIXED: "no slang" is a real instruction the
    // owner gave and the model could not map onto any of the six persisted
    // fields. Before the B1.18 gate, the proposal was approvable and execution
    // silently dropped "no slang" while reporting success — this assertion used
    // to read `toEqual([])` and was the THIRD copy of that false green in the
    // repo, after the two in brand-voice-task.test.ts.
    //
    // Deliberately not "fixed" by deleting `unmapped` from the mock. A real
    // owner saying this sentence does produce unmapped content, so a fixture
    // without it would be arranging the fixture to suit the code. The test
    // instead walks the path the product now has.
    expect(missingFieldsFor(drafted)).toEqual(['freeText']);
    expect(drafted.status).toBe('draft'); // manual action class — never auto-approved

    await proposalRepo.create(drafted);

    // 1b) The operator resolves the unmapped instruction on the review card.
    // `clearSatisfiedMissingFields` lifts the gate only when this exact key is
    // edited to a non-empty value, and `editProposal` re-validates the merged
    // payload against `updateBrandVoicePayloadSchema` first — so this step is
    // the human actually seeing "no slang" rather than it vanishing.
    const ungated: Proposal = await editProposal(
      proposalRepo,
      tenant.tenantId,
      drafted.id,
      tenant.userId,
      'owner',
      { freeText: 'no slang — avoid casual filler in customer messages' },
      auditRepo,
    );
    expect(missingFieldsFor(ungated)).toEqual([]);

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


  // Raised in PR review, and the reason `executed_by_role` (migration 266)
  // exists. The execution sweep runs detached from the approving request and
  // attributed work to `created_by` — the DRAFTER — passing no role at all, so
  // a technician-drafted brand-voice edit approved by an owner wrote and
  // audited as the technician with the role defaulted to 'owner'. Both halves
  // wrong, in opposite directions, and unrecoverable after the fact.
  //
  // Real Postgres because the column round-trip is the point: a mocked repo
  // would have happily "persisted" a column that does not exist.
  it('attributes a technician-drafted, owner-approved config write to the OWNER through the real sweep', async () => {
    const t = await createTestTenant(pool);
    await ensureTenantSettings(t.tenantId, settingsRepo);
    const technicianId = `${t.userId}-tech`;

    const drafted = createProposal({
      tenantId: t.tenantId,
      proposalType: 'update_brand_voice',
      payload: { register: 'formal' },
      summary: 'Set brand voice register to formal',
      createdBy: technicianId,
    });
    await proposalRepo.create(drafted);
    await proposalRepo.updateStatus(t.tenantId, drafted.id, 'ready_for_review');

    await approveProposal(
      proposalRepo,
      t.tenantId,
      drafted.id,
      t.userId,
      'owner',
      auditRepo,
      'ui',
    );

    // Re-read from Postgres: the approver's identity AND role survived the
    // round-trip through the new column, rather than living only in memory.
    const persisted = await proposalRepo.findById(t.tenantId, drafted.id);
    expect(persisted!.createdBy).toBe(technicianId);
    expect(persisted!.executedBy).toBe(t.userId);
    expect(persisted!.executedByRole).toBe('owner');

    // Backdate past the undo window so the sweep picks it up, then run the
    // REAL worker — the code path that was getting attribution wrong.
    await proposalRepo.updateStatus(t.tenantId, drafted.id, 'approved', {
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    });
    const registry = createExecutionHandlerRegistry({ brandVoiceRepo, auditRepo });
    const sweepExecutor = new ProposalExecutor(
      registry,
      proposalRepo,
      new IdempotencyGuard(new PgProposalExecutionRepository(pool), proposalRepo),
      auditRepo,
    );
    await runExecutionSweep({
      proposalRepo,
      executor: sweepExecutor,
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
    });

    expect((await proposalRepo.findById(t.tenantId, drafted.id))!.status).toBe('executed');

    const events = await auditRepo.findByEntity(t.tenantId, 'brand_voice', t.tenantId);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('brand_voice.updated');
    expect(events[0].actorId).toBe(t.userId);
    expect(events[0].actorId).not.toBe(technicianId);
    expect(events[0].actorRole).toBe('owner');

    // Cross-tenant negative: neither the write nor its audit leaks.
    const other = await createTestTenant(pool);
    expect((await brandVoiceRepo.getState(other.tenantId)).version).toBe(0);
    expect(await auditRepo.findByEntity(other.tenantId, 'brand_voice', t.tenantId)).toHaveLength(0);
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
