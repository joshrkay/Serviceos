import {
  createProposal,
  CreateProposalInput,
  Proposal,
} from '../../src/proposals/proposal';
import { prioritizeProposals, getUrgency } from '../../src/proposals/prioritization';

describe('P2-021 — Proposal inbox prioritization', () => {
  const tenantId = 'tenant-1';

  const baseInput: CreateProposalInput = {
    tenantId,
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer',
    createdBy: 'user-1',
  };

  function makeProposal(overrides?: Partial<Proposal> & Partial<Pick<CreateProposalInput, 'proposalType'>>): Proposal {
    const input: CreateProposalInput = {
      ...baseInput,
      ...(overrides?.proposalType ? { proposalType: overrides.proposalType } : {}),
    };
    const proposal = createProposal(input);
    if (overrides) {
      Object.assign(proposal, overrides);
    }
    return proposal;
  }

  it('happy path — expiring proposals sorted first', () => {
    const now = new Date();
    const expiringProposal = makeProposal({
      status: 'ready_for_review',
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000), // 30 min from now
    });
    const normalProposal = makeProposal({
      status: 'ready_for_review',
      createdAt: new Date(now.getTime() - 60 * 60 * 1000), // 1 hour ago
    });

    const result = prioritizeProposals([normalProposal, expiringProposal]);
    expect(result[0].urgency).toBe('critical');
    expect(result[0].proposal.id).toBe(expiringProposal.id);
    expect(result[0].reason).toBe('Expiring within 2 hours');
  });

  it('happy path — low confidence gets high urgency', () => {
    const lowConfidence = makeProposal({
      status: 'ready_for_review',
      confidenceScore: 0.3,
    });
    const highConfidence = makeProposal({
      status: 'ready_for_review',
      confidenceScore: 0.9,
    });

    const urgency = getUrgency(lowConfidence);
    expect(urgency.urgency).toBe('high');
    expect(urgency.reason).toBe('Low confidence score');

    const result = prioritizeProposals([highConfidence, lowConfidence]);
    expect(result[0].proposal.id).toBe(lowConfidence.id);
    expect(result[0].urgency).toBe('high');
  });

  it('happy path — older proposals before newer', () => {
    const now = new Date();
    const older = makeProposal({
      status: 'ready_for_review',
      confidenceScore: 0.8,
      createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    });
    const newer = makeProposal({
      status: 'ready_for_review',
      confidenceScore: 0.8,
      createdAt: new Date(now.getTime() - 30 * 60 * 1000),
    });

    const result = prioritizeProposals([newer, older]);
    expect(result[0].proposal.id).toBe(older.id);
    expect(result[1].proposal.id).toBe(newer.id);
  });

  it('happy path — type priority for tie-breaking', () => {
    const sameTime = new Date('2026-01-01T12:00:00Z');
    const estimate = makeProposal({
      proposalType: 'draft_estimate',
      status: 'ready_for_review',
      confidenceScore: 0.8,
      createdAt: sameTime,
      updatedAt: sameTime,
    });
    const customer = makeProposal({
      proposalType: 'create_customer',
      status: 'ready_for_review',
      confidenceScore: 0.8,
      createdAt: sameTime,
      updatedAt: sameTime,
    });
    const appointment = makeProposal({
      proposalType: 'create_appointment',
      status: 'ready_for_review',
      confidenceScore: 0.8,
      createdAt: sameTime,
      updatedAt: sameTime,
    });

    const result = prioritizeProposals([customer, appointment, estimate]);
    expect(result[0].proposal.proposalType).toBe('draft_estimate');
    expect(result[1].proposal.proposalType).toBe('create_appointment');
    expect(result[2].proposal.proposalType).toBe('create_customer');
  });

  it('validation — empty list returns empty', () => {
    const result = prioritizeProposals([]);
    expect(result).toEqual([]);
  });
});
