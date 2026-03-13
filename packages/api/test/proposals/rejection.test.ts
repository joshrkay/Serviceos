import {
  REJECTION_REASONS,
  isValidRejectionReason,
  recordRejection,
  getRejectionSignals,
  getTopRejectionReason,
  RejectionReason,
} from '../../src/proposals/rejection';
import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { ValidationError } from '../../src/shared/errors';

function makeProposal(overrides?: Partial<Proposal>): Proposal {
  const input: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'draft_estimate',
    payload: { lineItems: [], notes: 'test' },
    summary: 'Test proposal',
    createdBy: 'user-1',
  };
  const proposal = createProposal(input);
  if (overrides) {
    Object.assign(proposal, overrides);
  }
  return proposal;
}

describe('P2-018 — Proposal rejection reasons and correction signals', () => {
  it('happy path — records rejection with reason', () => {
    const proposal = makeProposal();
    const record = recordRejection(proposal, 'wrong_pricing', undefined, 'reviewer-1');

    expect(record.proposalId).toBe(proposal.id);
    expect(record.tenantId).toBe('tenant-1');
    expect(record.reason).toBe('wrong_pricing');
    expect(record.rejectedBy).toBe('reviewer-1');
    expect(record.proposalType).toBe('draft_estimate');
    expect(record.rejectedAt).toBeInstanceOf(Date);
  });

  it('happy path — aggregates rejection signals by type', async () => {
    const repo = new InMemoryProposalRepository();

    const p1 = makeProposal({ status: 'rejected', rejectionReason: 'wrong_pricing' });
    const p2 = makeProposal({ status: 'rejected', rejectionReason: 'wrong_pricing' });
    const p3 = makeProposal({ status: 'rejected', rejectionReason: 'missing_info' });

    await repo.create(p1);
    await repo.create(p2);
    await repo.create(p3);

    const signals = await getRejectionSignals(repo, 'tenant-1');

    expect(signals.length).toBe(2);
    const pricingSignal = signals.find((s) => s.reason === 'wrong_pricing');
    const infoSignal = signals.find((s) => s.reason === 'missing_info');
    expect(pricingSignal?.count).toBe(2);
    expect(infoSignal?.count).toBe(1);
  });

  it('validation — rejects invalid rejection reason', () => {
    expect(isValidRejectionReason('not_a_reason')).toBe(false);
    expect(isValidRejectionReason('')).toBe(false);

    for (const reason of REJECTION_REASONS) {
      expect(isValidRejectionReason(reason)).toBe(true);
    }
  });

  it('happy path — top rejection reason identified', () => {
    const signals = [
      { reason: 'missing_info' as RejectionReason, count: 5 },
      { reason: 'wrong_pricing' as RejectionReason, count: 10 },
      { reason: 'wrong_entity' as RejectionReason, count: 2 },
    ];

    // getRejectionSignals sorts by count desc, but getTopRejectionReason just takes first
    const sorted = [...signals].sort((a, b) => b.count - a.count);
    const top = getTopRejectionReason(sorted);
    expect(top).toBe('wrong_pricing');

    expect(getTopRejectionReason([])).toBeNull();
  });

  it('happy path — details captured with reason', () => {
    const proposal = makeProposal();
    const record = recordRejection(proposal, 'wrong_wording', 'The tone is too informal', 'reviewer-2');

    expect(record.reason).toBe('wrong_wording');
    expect(record.details).toBe('The tone is too informal');
  });

  it('happy path — filters signals by task type', async () => {
    const repo = new InMemoryProposalRepository();

    const estimate1 = makeProposal({
      proposalType: 'draft_estimate',
      status: 'rejected',
      rejectionReason: 'wrong_pricing',
    });
    const estimate2 = makeProposal({
      proposalType: 'draft_estimate',
      status: 'rejected',
      rejectionReason: 'missing_info',
    });
    const customer1 = makeProposal({
      proposalType: 'create_customer',
      status: 'rejected',
      rejectionReason: 'wrong_entity',
    });

    await repo.create(estimate1);
    await repo.create(estimate2);
    await repo.create(customer1);

    const estimateSignals = await getRejectionSignals(repo, 'tenant-1', 'draft_estimate');
    expect(estimateSignals.length).toBe(2);
    expect(estimateSignals.find((s) => s.reason === 'wrong_entity')).toBeUndefined();

    const customerSignals = await getRejectionSignals(repo, 'tenant-1', 'create_customer');
    expect(customerSignals.length).toBe(1);
    expect(customerSignals[0].reason).toBe('wrong_entity');
  });
});
