/**
 * I2 (#1020, lane A) — "No `system:` actor may ever approve a proposal"
 * (D-019), proven against real Postgres.
 *
 * `packages/api/test/proposals/lifecycle.test.ts` proves the D-019 guard
 * only against in-memory `Proposal` objects — the PRD's own note is that
 * zero integration tests attempt a `system:` approval. This file proves the
 * SAME guard at the real seam every HTTP/voice approval path actually flows
 * through — `approveProposal` (proposals/actions.ts), which calls
 * `transitionProposal` (proposals/lifecycle.ts) and persists through
 * `PgProposalRepository` — against a real database:
 *
 *   1. From EVERY starting `ProposalStatus`, a `system:` actor attempting
 *      `approved` throws `ForbiddenError`, with NO row change (status is
 *      unchanged when read back) and NO audit row at all (specifically no
 *      `proposal.approved` and no `proposal.executed` row) via
 *      `PgAuditRepository.findByEntity`.
 *   2. A human actor approving the SAME proposal type succeeds, and its
 *      `proposal.approved` audit row round-trips through
 *      `PgAuditRepository.findByEntity`.
 *   3. T1 — a second tenant's proposals are untouched by the first
 *      tenant's rejected system-actor attempts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { approveProposal } from '../../src/proposals/actions';
import { createProposal, Proposal, ProposalStatus } from '../../src/proposals/proposal';
import { ForbiddenError, NotFoundError } from '../../src/shared/errors';

// Every member of ProposalStatus — a system actor must be refused from ALL
// of them, not just the reachable ones, because the D-019 guard in
// transitionProposal fires before the state-machine legality check.
const ALL_STATUSES: ProposalStatus[] = [
  'draft',
  'ready_for_review',
  'approved',
  'executing',
  'rejected',
  'expired',
  'executed',
  'execution_failed',
  'undone',
];

async function seedProposal(
  proposalRepo: PgProposalRepository,
  tenantId: string,
  userId: string,
  status: ProposalStatus,
): Promise<Proposal> {
  const proposal = createProposal({
    tenantId,
    proposalType: 'create_customer',
    payload: { name: 'I2 System Actor Test Customer' },
    summary: 'I2 system-actor approval attempt',
    createdBy: userId,
  });
  proposal.status = status;
  return proposalRepo.create(proposal);
}

describe('I2 — system: actor approval is refused at the real Postgres lifecycle seam', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  it.each(ALL_STATUSES)(
    'from status=%s, a system: actor approval throws ForbiddenError with no row change and no audit row',
    async (status) => {
      const tenant = await createTestTenant(pool);
      const proposal = await seedProposal(proposalRepo, tenant.tenantId, tenant.userId, status);

      await expect(
        approveProposal(
          proposalRepo,
          tenant.tenantId,
          proposal.id,
          'system:autonomous-close',
          'owner',
          auditRepo,
        ),
      ).rejects.toThrow(ForbiddenError);

      // No row change — the proposal is still exactly as seeded.
      const after = await proposalRepo.findById(tenant.tenantId, proposal.id);
      expect(after?.status).toBe(status);

      // No audit row of any kind for this proposal — specifically neither
      // proposal.approved nor proposal.executed.
      const auditRows = await auditRepo.findByEntity(tenant.tenantId, 'proposal', proposal.id);
      expect(auditRows).toHaveLength(0);
      expect(auditRows.some((r) => r.eventType === 'proposal.approved')).toBe(false);
      expect(auditRows.some((r) => r.eventType === 'proposal.executed')).toBe(false);
    },
  );

  it('a human actor approving the same proposal type succeeds, with its audit row readable via PgAuditRepository.findByEntity', async () => {
    const tenant = await createTestTenant(pool);
    const proposal = await seedProposal(
      proposalRepo,
      tenant.tenantId,
      tenant.userId,
      'ready_for_review',
    );

    const approved = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      proposal.id,
      tenant.userId,
      'owner',
      auditRepo,
    );
    expect(approved.status).toBe('approved');

    const persisted = await proposalRepo.findById(tenant.tenantId, proposal.id);
    expect(persisted?.status).toBe('approved');

    const auditRows = await auditRepo.findByEntity(tenant.tenantId, 'proposal', proposal.id);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].eventType).toBe('proposal.approved');
    expect(auditRows[0].entityType).toBe('proposal');
    expect(auditRows[0].entityId).toBe(proposal.id);
    expect(auditRows[0].actorId).toBe(tenant.userId);
    expect(auditRows[0].actorRole).toBe('owner');
  });

  it('T1 — a second tenant is completely untouched by tenant A\'s rejected system-actor attempts', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);

    const proposalA = await seedProposal(
      proposalRepo,
      tenantA.tenantId,
      tenantA.userId,
      'ready_for_review',
    );
    const proposalB = await seedProposal(
      proposalRepo,
      tenantB.tenantId,
      tenantB.userId,
      'ready_for_review',
    );

    // Repeatedly attempt (and fail) a system-actor approval against
    // tenant A's proposal.
    await expect(
      approveProposal(
        proposalRepo,
        tenantA.tenantId,
        proposalA.id,
        'system:autonomous-close',
        'owner',
        auditRepo,
      ),
    ).rejects.toThrow(ForbiddenError);

    // Tenant B's proposal is untouched: status unchanged, zero audit rows,
    // and tenant B's own audit trail is empty (proves the failed attempt on
    // tenant A produced no cross-tenant leakage of any kind).
    const proposalBAfter = await proposalRepo.findById(tenantB.tenantId, proposalB.id);
    expect(proposalBAfter?.status).toBe('ready_for_review');
    expect(await auditRepo.findByEntity(tenantB.tenantId, 'proposal', proposalB.id)).toHaveLength(
      0,
    );

    // Cross-tenant reads/writes: tenant B's scope can never see or act on
    // tenant A's proposal — the tenant predicate itself, not just the
    // outcome of the rejected system-actor attempt, is what's under test
    // here. A regression that dropped the tenant_id filter from
    // PgProposalRepository.findById or the approval lookup would fail this.
    expect(await proposalRepo.findById(tenantB.tenantId, proposalA.id)).toBeNull();
    await expect(
      approveProposal(
        proposalRepo,
        tenantB.tenantId,
        proposalA.id,
        tenantB.userId,
        'owner',
        auditRepo,
      ),
    ).rejects.toThrow(NotFoundError);

    // Tenant B can still have ITS proposal approved by a human — the D-019
    // guard on tenant A did not wedge anything tenant-wide.
    const approvedB = await approveProposal(
      proposalRepo,
      tenantB.tenantId,
      proposalB.id,
      tenantB.userId,
      'owner',
      auditRepo,
    );
    expect(approvedB.status).toBe('approved');
  });
});
