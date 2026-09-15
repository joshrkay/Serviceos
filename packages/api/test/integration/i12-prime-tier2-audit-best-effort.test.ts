import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuditEvent, AuditRepository } from '../../src/audit/audit';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import { CallbackExecutionHandler } from '../../src/proposals/execution/callback-handler';
import type {
  ExecutionContext,
  ExecutionHandler,
} from '../../src/proposals/execution/handlers';
import {
  createProposal,
  type Proposal,
  type ProposalType,
} from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';

/**
 * I12′ (§5.0b, tier 2) at REAL Postgres — "a handler whose `auditRepo.create`
 * throws still succeeds, with its mutation committed".
 *
 * §5.0b states the consequence in prose and the PRD row marks it 🚨 as proven
 * in memory only (`test/proposals/callback-handler.test.ts`, a stub audit
 * repo): *"During an audit-store outage, operational state can be created
 * without its domain audit row. The execution-outcome row still lands on the
 * DB-only path; the domain-level event does not."* This file makes that exact
 * sentence falsifiable against a real database.
 *
 * Seams driven:
 *   - tier 2 swallow — src/proposals/execution/callback-handler.ts:123-131
 *     (`catch (auditErr)` around the `callback.acknowledged` create)
 *   - tier 1 outcome  — src/proposals/execution/executor.ts, the
 *     `proposal.executed` write inside the executor's transaction
 *
 * The outage is simulated at the ONE call the PRD's guarantee is about: a
 * `Tier2FailingAuditRepository` wraps a REAL `PgAuditRepository` and throws
 * only for the handler's `callback.acknowledged` event. Every other write —
 * the executor's tier-1 `proposal.executed` row above all — goes through the
 * real repository untouched, which is what makes "tier 1 survived, tier 2 did
 * not" a claim about the product rather than about the double.
 *
 * SCOPE (ticket #1020, lane B): the `callback-handler` family named by the
 * PRD, and no wider. Measured counts, so the "~40 swallow sites untested" note
 * on the PRD row has a number behind it: 8 handlers in
 * `src/proposals/execution/` carry the same explicit `catch (auditErr)` swallow
 * (add-catalog-item, add-material, callback, create-change-order,
 * create-service-agreement, log-expense, record-refund, send-customer-message);
 * 9 files under `src/proposals/execution/` contain an audit-swallow-shaped
 * catch; 11 such catches exist across `src/`. Seven of the eight named handlers
 * remain untested at a real DB, and the money handler the parent ticket also
 * asks for is NOT covered here — see the lane report.
 */

/**
 * A real `PgAuditRepository` with ONE event type knocked out. `create` throws
 * for `callback.acknowledged` (the tier-2 domain event) and delegates
 * everything else, so the executor's tier-1 write is genuinely a real-Postgres
 * write on the real code path.
 */
class Tier2FailingAuditRepository implements AuditRepository {
  public attemptedTier2 = 0;

  /**
   * `failForTenantId` scopes the outage to one tenant. The T1 test runs BOTH
   * tenants through a single failure-injected executor — one wired handler
   * instance serving many tenants, which is the production shape — so that a
   * process-wide outage could not pass as tenant isolation.
   */
  constructor(
    private readonly inner: PgAuditRepository,
    private readonly failForTenantId?: string,
  ) {}

  async create(event: AuditEvent): Promise<AuditEvent> {
    const inScope =
      this.failForTenantId === undefined || event.tenantId === this.failForTenantId;
    if (event.eventType === 'callback.acknowledged' && inScope) {
      this.attemptedTier2 += 1;
      throw new Error('audit store unavailable (I12′ simulated tier-2 outage)');
    }
    return this.inner.create(event);
  }

  findByEntity(tenantId: string, entityType: string, entityId: string): Promise<AuditEvent[]> {
    return this.inner.findByEntity(tenantId, entityType, entityId);
  }

  findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEvent[]> {
    return this.inner.findByCorrelation(tenantId, correlationId);
  }
}

async function makeApprovedCallback(
  proposalRepo: PgProposalRepository,
  tenantId: string,
  userId: string,
): Promise<Proposal> {
  let proposal = createProposal({
    tenantId,
    proposalType: 'callback' as ProposalType,
    payload: {
      reason: 'burst pipe — wants a call back',
      callerPhone: '+15125557788',
      conversationId: randomUUID(),
    },
    summary: 'Call back the Tuesday caller',
    createdBy: userId,
    idempotencyKey: `i12p-${randomUUID()}`,
  });
  proposal = transitionProposal(proposal, 'ready_for_review', 'test');
  proposal = transitionProposal(proposal, 'approved', 'test');
  // Past the 5s undo window so the executor runs immediately.
  proposal = { ...proposal, approvedAt: new Date(Date.now() - 10_000) };
  return proposalRepo.create(proposal);
}

describe('I12′ — §5.0b tier-2 handler audit is best-effort, proven at real Postgres', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;
  let realAuditRepo: PgAuditRepository;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  function makeGuard(): IdempotencyGuard {
    return new IdempotencyGuard(executionRepo, proposalRepo, new PgIdempotencyLockProvider(pool));
  }

  function makeExecutor(handlerAuditRepo: AuditRepository): ProposalExecutor {
    return new ProposalExecutor(
      new Map<ProposalType, ExecutionHandler>([
        ['callback' as ProposalType, new CallbackExecutionHandler(handlerAuditRepo)],
      ]),
      proposalRepo,
      makeGuard(),
      // Tier 1 always goes through the REAL repository — the outage is
      // scoped to the handler's own domain event.
      realAuditRepo,
      { executionRepo },
    );
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
    realAuditRepo = new PgAuditRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('control: with a healthy audit store BOTH tiers land — proposal.executed and callback.acknowledged', async () => {
    const executor = makeExecutor(realAuditRepo);
    const proposal = await makeApprovedCallback(proposalRepo, tenantA.tenantId, tenantA.userId);
    const ctx: ExecutionContext = { tenantId: tenantA.tenantId, executedBy: tenantA.userId };

    const { proposal: after, result } = await executor.execute(proposal, ctx);
    expect(result.success).toBe(true);
    expect(after.status).toBe('executed');

    const rows = await realAuditRepo.findByEntity(tenantA.tenantId, 'proposal', proposal.id);
    const types = rows.map((r) => r.eventType);
    expect(types).toContain('proposal.executed');
    expect(types).toContain('callback.acknowledged');
  });

  it('tier-2 outage: the domain audit row is LOST but the execution commits and the tier-1 outcome row survives', async () => {
    const failing = new Tier2FailingAuditRepository(realAuditRepo);
    const executor = makeExecutor(failing);
    const proposal = await makeApprovedCallback(proposalRepo, tenantA.tenantId, tenantA.userId);
    const ctx: ExecutionContext = { tenantId: tenantA.tenantId, executedBy: tenantA.userId };

    // The handler throws inside its own audit call — and the execution still
    // succeeds. This is the §5.0b guarantee, not a bug.
    const { proposal: after, result } = await executor.execute(proposal, ctx);
    expect(result.success).toBe(true);
    expect(failing.attemptedTier2).toBe(1);

    // The mutation COMMITTED — the status transition is in real Postgres, not
    // just on the returned object.
    expect(after.status).toBe('executed');
    const persisted = await proposalRepo.findById(tenantA.tenantId, proposal.id);
    expect(persisted?.status).toBe('executed');

    // …and so did the idempotency record that rides the same unit.
    const marker = await executionRepo.findByIdempotencyKey(
      tenantA.tenantId,
      proposal.idempotencyKey!,
    );
    expect(marker).not.toBeNull();

    // Tier 1 SURVIVED the tier-2 outage — read back through the real repo.
    const rows = await realAuditRepo.findByEntity(tenantA.tenantId, 'proposal', proposal.id);
    const types = rows.map((r) => r.eventType);
    expect(types).toContain('proposal.executed');

    // Tier 2 is GONE. This is the consequence §5.0b states in prose:
    // operational state exists with no domain audit row behind it.
    expect(types).not.toContain('callback.acknowledged');

    // Pinned against the real table too, not only through the repository —
    // a nonexistent column would fail here, a mocked pool would not.
    const raw = await pool.query<{ event_type: string; actor_role: string }>(
      `SELECT event_type, actor_role FROM audit_events
        WHERE tenant_id = $1 AND entity_type = 'proposal' AND entity_id = $2
        ORDER BY created_at`,
      [tenantA.tenantId, proposal.id],
    );
    expect(raw.rows.map((r) => r.event_type)).toEqual(['proposal.executed']);
  });

  it('T1 — a second tenant executing the same proposal type is unaffected by the first tenant’s outage', async () => {
    // ONE failure-injected executor — one wired CallbackExecutionHandler
    // instance, as in production — with the outage scoped to tenant A. Running
    // tenant B through a SEPARATE healthy executor would also pass if the
    // outage were process-wide, which would prove nothing about isolation.
    const failing = new Tier2FailingAuditRepository(realAuditRepo, tenantA.tenantId);
    const executor = makeExecutor(failing);

    const outageProposal = await makeApprovedCallback(
      proposalRepo,
      tenantA.tenantId,
      tenantA.userId,
    );
    await executor.execute(outageProposal, {
      tenantId: tenantA.tenantId,
      executedBy: tenantA.userId,
    });
    expect(failing.attemptedTier2).toBe(1);

    const healthyProposal = await makeApprovedCallback(
      proposalRepo,
      tenantB.tenantId,
      tenantB.userId,
    );
    const { result } = await executor.execute(healthyProposal, {
      tenantId: tenantB.tenantId,
      executedBy: tenantB.userId,
    });
    expect(result.success).toBe(true);
    // Tenant B's tier-2 write went through the SAME wrapper and was not
    // knocked out — the counter is still 1.
    expect(failing.attemptedTier2).toBe(1);

    // Tenant B kept BOTH tiers.
    const bTypes = (
      await realAuditRepo.findByEntity(tenantB.tenantId, 'proposal', healthyProposal.id)
    ).map((r) => r.eventType);
    expect(bTypes).toContain('proposal.executed');
    expect(bTypes).toContain('callback.acknowledged');

    // Tenant A still lost only its own tier-2 row.
    const aTypes = (
      await realAuditRepo.findByEntity(tenantA.tenantId, 'proposal', outageProposal.id)
    ).map((r) => r.eventType);
    expect(aTypes).toContain('proposal.executed');
    expect(aTypes).not.toContain('callback.acknowledged');

    // Cross-tenant isolation: neither tenant can read the other's rows.
    expect(
      await realAuditRepo.findByEntity(tenantA.tenantId, 'proposal', healthyProposal.id),
    ).toHaveLength(0);
    expect(
      await realAuditRepo.findByEntity(tenantB.tenantId, 'proposal', outageProposal.id),
    ).toHaveLength(0);
    expect(await proposalRepo.findById(tenantB.tenantId, outageProposal.id)).toBeNull();
    expect(await proposalRepo.findById(tenantA.tenantId, healthyProposal.id)).toBeNull();
  });
});
