import { describe, it, expect } from 'vitest';
import {
  InMemoryProposalRepository,
  createProposal,
  type ProposalStatus,
} from '../../src/proposals/proposal';

/**
 * ANS-001 — `updateStatusIf` semantics. The E1 booking revocation depends on
 * the precondition being part of the write, not a prior read: the execution
 * worker can move a proposal approved → executing → executed between the two.
 * The Pg implementation folds `status = ANY($from)` into the UPDATE; this pins
 * the shape both implementations must agree on.
 */
const TENANT = 'tenant-1';
const LIVE: ProposalStatus[] = ['draft', 'ready_for_review', 'approved'];

async function seed(repo: InMemoryProposalRepository, status?: ProposalStatus) {
  const proposal = await repo.create(
    createProposal({
      tenantId: TENANT,
      proposalType: 'create_appointment',
      payload: {},
      summary: 'Book a visit',
      createdBy: 'voice',
    }),
  );
  if (status) await repo.updateStatus(TENANT, proposal.id, status);
  return proposal;
}

describe('ProposalRepository.updateStatusIf', () => {
  it('writes when the current status is in the precondition set', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await seed(repo);

    const updated = await repo.updateStatusIf(TENANT, proposal.id, LIVE, 'rejected');

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('rejected');
    expect((await repo.findById(TENANT, proposal.id))!.status).toBe('rejected');
  });

  it('returns null and leaves the row untouched when the precondition missed', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await seed(repo, 'executed');

    const updated = await repo.updateStatusIf(TENANT, proposal.id, LIVE, 'rejected');

    expect(updated).toBeNull();
    // The terminal status survives — the whole point of the conditional write.
    expect((await repo.findById(TENANT, proposal.id))!.status).toBe('executed');
  });

  it('applies the rejection metadata exactly like updateStatus', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await seed(repo);

    const updated = await repo.updateStatusIf(TENANT, proposal.id, LIVE, 'rejected', {
      rejectionReason: 'life_safety_emergency',
      rejectionDetails: 'E1 life-safety signal during the call',
    });

    expect(updated!.rejectionReason).toBe('life_safety_emergency');
    expect(updated!.rejectionDetails).toBe('E1 life-safety signal during the call');
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(proposal.updatedAt.getTime());
  });

  it('is second-write-safe: the same conditional revoke twice is a no-op', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await seed(repo);

    const first = await repo.updateStatusIf(TENANT, proposal.id, LIVE, 'rejected');
    const second = await repo.updateStatusIf(TENANT, proposal.id, LIVE, 'rejected');

    expect(first).not.toBeNull();
    // 'rejected' is not in the precondition set, so the replay can't rewrite it.
    expect(second).toBeNull();
  });

  it('returns null for another tenant’s proposal (never cross-tenant)', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = await seed(repo);

    const updated = await repo.updateStatusIf('tenant-2', proposal.id, LIVE, 'rejected');

    expect(updated).toBeNull();
    expect((await repo.findById(TENANT, proposal.id))!.status).toBe(proposal.status);
  });

  it('returns null for an unknown id', async () => {
    const repo = new InMemoryProposalRepository();
    expect(
      await repo.updateStatusIf(TENANT, 'no-such-id', LIVE, 'rejected'),
    ).toBeNull();
  });
});
