import {
  InMemoryProposalAnalyticsRepository,
  recordProposalOutcome,
  getAnalyticsSummary,
  ProposalAnalyticsRepository,
} from '../../src/proposals/analytics';
import {
  createProposal,
  CreateProposalInput,
  Proposal,
} from '../../src/proposals/proposal';

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

describe('P2-019 — Proposal outcome analytics foundation', () => {
  let repo: ProposalAnalyticsRepository;

  beforeEach(() => {
    repo = new InMemoryProposalAnalyticsRepository();
  });

  it('happy path — records approval outcome', async () => {
    const proposal = makeProposal({ status: 'approved', confidenceScore: 0.9 });

    const outcome = await recordProposalOutcome(repo, proposal);

    expect(outcome.proposalId).toBe(proposal.id);
    expect(outcome.tenantId).toBe('tenant-1');
    expect(outcome.proposalType).toBe('draft_estimate');
    expect(outcome.outcome).toBe('approved');
    expect(outcome.confidenceScore).toBe(0.9);
    expect(outcome.editedFields).toBeUndefined();
    expect(outcome.recordedAt).toBeInstanceOf(Date);
  });

  it('happy path — records rejection outcome', async () => {
    const proposal = makeProposal({
      status: 'rejected',
      rejectionReason: 'wrong_pricing',
      confidenceScore: 0.5,
    });

    const outcome = await recordProposalOutcome(repo, proposal);

    expect(outcome.outcome).toBe('rejected');
    expect(outcome.rejectionReason).toBe('wrong_pricing');
    expect(outcome.confidenceScore).toBe(0.5);
  });

  it('happy path — records approval with edits', async () => {
    const proposal = makeProposal({ status: 'approved', confidenceScore: 0.8 });

    const outcome = await recordProposalOutcome(repo, proposal, ['price', 'description']);

    expect(outcome.outcome).toBe('approved_with_edits');
    expect(outcome.editedFields).toEqual(['price', 'description']);
  });

  it('happy path — computes analytics summary', async () => {
    const approved1 = makeProposal({ status: 'approved', confidenceScore: 0.9 });
    const approved2 = makeProposal({ status: 'approved', confidenceScore: 0.8 });
    const rejected1 = makeProposal({ status: 'rejected', confidenceScore: 0.4 });
    const failed1 = makeProposal({ status: 'execution_failed', confidenceScore: 0.7 });

    await recordProposalOutcome(repo, approved1);
    await recordProposalOutcome(repo, approved2, ['price']);
    await recordProposalOutcome(repo, rejected1);
    await recordProposalOutcome(repo, failed1);

    const summary = await getAnalyticsSummary(repo, 'tenant-1');

    expect(summary.totalProposals).toBe(4);
    expect(summary.approvalRate).toBe(0.5); // 2 approved out of 4
    expect(summary.editRate).toBe(0.25); // 1 edited out of 4
    expect(summary.rejectionRate).toBe(0.25);
    expect(summary.executionFailureRate).toBe(0.25);
    expect(summary.averageConfidence).toBeCloseTo(0.7);
  });

  it('happy path — groups by proposal type', async () => {
    const estimate = makeProposal({
      proposalType: 'draft_estimate',
      status: 'approved',
      confidenceScore: 0.9,
    });
    const customer = makeProposal({
      proposalType: 'create_customer',
      status: 'rejected',
      confidenceScore: 0.5,
    });
    const estimate2 = makeProposal({
      proposalType: 'draft_estimate',
      status: 'rejected',
      confidenceScore: 0.6,
    });

    await recordProposalOutcome(repo, estimate);
    await recordProposalOutcome(repo, customer);
    await recordProposalOutcome(repo, estimate2);

    const summary = await getAnalyticsSummary(repo, 'tenant-1');

    expect(summary.byType['draft_estimate']).toEqual({
      total: 2,
      approved: 1,
      rejected: 1,
      edited: 0,
    });
    expect(summary.byType['create_customer']).toEqual({
      total: 1,
      approved: 0,
      rejected: 1,
      edited: 0,
    });
  });

  it('validation — tenant isolation in analytics', async () => {
    const t1Proposal = makeProposal({ tenantId: 'tenant-1', status: 'approved' });
    const t2Proposal = makeProposal({ tenantId: 'tenant-2', status: 'rejected' });

    await recordProposalOutcome(repo, t1Proposal);
    await recordProposalOutcome(repo, t2Proposal);

    const t1Summary = await getAnalyticsSummary(repo, 'tenant-1');
    expect(t1Summary.totalProposals).toBe(1);
    expect(t1Summary.approvalRate).toBe(1);

    const t2Summary = await getAnalyticsSummary(repo, 'tenant-2');
    expect(t2Summary.totalProposals).toBe(1);
    expect(t2Summary.rejectionRate).toBe(1);
  });
});
