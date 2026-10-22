import { assertStatusWrite } from '../../src/proposals/lifecycle';
import {
  createProposal,
  InMemoryProposalRepository,
  type ProposalStatus,
} from '../../src/proposals/proposal';
import { ConflictError } from '../../src/shared/errors';

// The repository is the one place a proposal's status is written, so the
// lifecycle table is enforced there rather than by each caller's discipline.
describe('proposal status-write gate', () => {
  async function seeded(status: ProposalStatus) {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_customer',
      payload: { name: 'Jane Doe' },
      summary: 'Create customer',
      createdBy: 'user-1',
    });
    proposal.status = status;
    await repo.create(proposal);
    return { repo, id: proposal.id };
  }

  it('allows a listed move and a same-status re-stamp', () => {
    expect(() => assertStatusWrite('draft', 'ready_for_review')).not.toThrow();
    expect(() => assertStatusWrite('executing', 'executing')).not.toThrow();
  });

  it('refuses an unlisted move', () => {
    expect(() => assertStatusWrite('executed', 'ready_for_review')).toThrow(ConflictError);
    expect(() => assertStatusWrite('expired', 'approved')).toThrow(ConflictError);
  });

  it.each<[ProposalStatus, ProposalStatus]>([
    ['ready_for_review', 'draft'], // supervisor hold
    ['approved', 'executing'], // execution claim
    ['executing', 'approved'], // chain dependent released
    ['approved', 'rejected'], // E1 caller revocation
  ])('lists the as-built move %s → %s', (from, to) => {
    expect(() => assertStatusWrite(from, to)).not.toThrow();
  });

  it('updateStatus refuses to reopen a terminal proposal and leaves it unchanged', async () => {
    const { repo, id } = await seeded('executed');
    await expect(repo.updateStatus('tenant-1', id, 'ready_for_review')).rejects.toThrow(ConflictError);
    expect((await repo.findById('tenant-1', id))?.status).toBe('executed');
  });

  it('updateStatus applies a legal move', async () => {
    const { repo, id } = await seeded('draft');
    const updated = await repo.updateStatus('tenant-1', id, 'ready_for_review');
    expect(updated?.status).toBe('ready_for_review');
  });

  it('updateStatusIf refuses a precondition list containing an illegal edge', async () => {
    const { repo, id } = await seeded('draft');
    await expect(
      repo.updateStatusIf('tenant-1', id, ['draft', 'executed'], 'ready_for_review'),
    ).rejects.toThrow(ConflictError);
    expect((await repo.findById('tenant-1', id))?.status).toBe('draft');
  });
});
