import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { NegotiationGuardrailTaskHandler } from '../../src/ai/tasks/negotiation-task';
import { ensureTenantSettings } from '../../src/settings/settings';
import type { CurrentQuoteResolver } from '../../src/conversations/negotiation/current-quote-resolver';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';

/**
 * §8.7 G1 audit (#1008 on ticket #1012), row 7.12 — "As M, I want the AI to
 * refuse to negotiate and hand it to me instead, so it never discounts my
 * work." Unit coverage was 3/3 against in-memory settingsRepo/quoteResolver
 * stubs (test/ai/tasks/negotiation-task.test.ts). This proves the SAME
 * ALLOW-branch callback (the capture-class, confidence-capped owner
 * callback — the one path in this handler that also emits an audit event)
 * persists at real Postgres: the proposal row through PgProposalRepository,
 * and the `negotiation.discount_evaluated` audit event through
 * PgAuditRepository. Fixture values (10% cap, $250 quote, "$230" ask →
 * 8% approved) are lifted verbatim from the passing unit test so this is
 * known to land in the ALLOW branch, not NEEDS_APPROVAL/CLARIFY.
 *
 * quoteResolver stays an in-memory stub — it's a domain resolver (not a
 * repository) and is not what this row is proving; settingsRepo, the
 * proposal repo and the audit repo are all real.
 */
describe('Postgres integration — negotiation guardrail owner-callback persistence (7.12)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    // createTestTenant only inserts tenants/users — tenant_settings.update()
    // is a bare UPDATE (no upsert; see PgSettingsRepository.update), so a
    // fresh tenant needs its settings row created first, exactly as the real
    // bootstrap flow (auth/clerk.ts) and the estimate/invoice number
    // safety-net (getNextEstimateNumber/getNextInvoiceNumber) both do via
    // this same idempotent helper.
    await ensureTenantSettings(tenant.tenantId, settingsRepo);
    await settingsRepo.update(tenant.tenantId, {
      discountMaxBps: 1000, // 10% cap
      discountFloorCents: 15000,
      discountNeverBelowCatalog: true,
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('an in-policy discount ask persists a capture-class, confidence-capped callback proposal AND its audit event', async () => {
    const quoteResolver: CurrentQuoteResolver = {
      resolve: async () => ({ estimateId: 'est-1', quotedCents: 25000, catalogGrounded: true }),
    };
    const handler = new NegotiationGuardrailTaskHandler(undefined, {
      settingsRepo,
      quoteResolver,
      auditRepo,
    });

    const context: TaskContext = {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'can you do $230?',
      existingEntities: { customerId: 'c-1' },
    };
    const { proposal, taskType } = await handler.handle(context);
    expect(taskType).toBe('callback');
    // Capture-class: no sourceTrustTier, and the confidence cap below forces
    // 'draft' regardless — the AI never auto-applies a discount.
    expect(proposal.status).toBe('draft');
    const meta = proposal.payload._meta as { overallConfidence: string };
    expect(meta.overallConfidence).toBe('low');
    expect(proposal.payload.approvedDiscountBps).toBe(800); // $250 → $230 = 8% (< 10% cap)

    // Persist through the REAL repo — the row, not just the in-memory object
    // handle() returns. A new file that never opens a pool would not count.
    const persisted = await proposalRepo.create(proposal);
    const reloaded = await proposalRepo.findById(tenant.tenantId, persisted.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe('draft');
    expect(reloaded!.proposalType).toBe('callback');

    // The discount evaluation's audit event landed for real. No
    // recordingId/conversationId was supplied, so auditDecision's entityId
    // falls back to the tenantId (see NegotiationGuardrailTaskHandler.auditDecision).
    const events = await auditRepo.findByEntity(tenant.tenantId, 'proposal', tenant.tenantId);
    expect(events.map((e) => e.eventType)).toContain('negotiation.discount_evaluated');
  });
});
