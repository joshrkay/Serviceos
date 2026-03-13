import {
  canTransition,
  isTerminalStatus,
  transitionProposal,
} from '../../src/proposals/lifecycle';
import { createProposal, Proposal, CreateProposalInput } from '../../src/proposals/proposal';
import { ConflictError } from '../../src/shared/errors';

describe('P2-003 — Proposal lifecycle transitions', () => {
  const baseInput: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer from voice call',
    createdBy: 'user-1',
  };

  function makeProposal(overrides?: Partial<Proposal>): Proposal {
    const proposal = createProposal(baseInput);
    if (overrides) {
      Object.assign(proposal, overrides);
    }
    return proposal;
  }

  it('happy path — draft to ready_for_review', () => {
    const proposal = makeProposal({ status: 'draft' });
    const result = transitionProposal(proposal, 'ready_for_review', 'user-1');
    expect(result.status).toBe('ready_for_review');
    expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(proposal.updatedAt.getTime());
  });

  it('happy path — ready_for_review to approved', () => {
    const proposal = makeProposal({ status: 'ready_for_review' });
    const result = transitionProposal(proposal, 'approved', 'user-1');
    expect(result.status).toBe('approved');
  });

  it('happy path — ready_for_review to rejected', () => {
    const proposal = makeProposal({ status: 'ready_for_review' });
    const result = transitionProposal(proposal, 'rejected', 'user-1');
    expect(result.status).toBe('rejected');
  });

  it('happy path — approved to executed', () => {
    const proposal = makeProposal({ status: 'approved' });
    const result = transitionProposal(proposal, 'executed', 'user-1');
    expect(result.status).toBe('executed');
  });

  it('happy path — approved to execution_failed', () => {
    const proposal = makeProposal({ status: 'approved' });
    const result = transitionProposal(proposal, 'execution_failed', 'user-1');
    expect(result.status).toBe('execution_failed');
  });

  it('happy path — rejected to draft (re-draft)', () => {
    const proposal = makeProposal({ status: 'rejected' });
    const result = transitionProposal(proposal, 'draft', 'user-1');
    expect(result.status).toBe('draft');
  });

  it('happy path — execution_failed to draft (retry)', () => {
    const proposal = makeProposal({ status: 'execution_failed' });
    const result = transitionProposal(proposal, 'draft', 'user-1');
    expect(result.status).toBe('draft');
  });

  it('validation — rejects draft to approved (skip)', () => {
    const proposal = makeProposal({ status: 'draft' });
    expect(() => transitionProposal(proposal, 'approved', 'user-1')).toThrow(ConflictError);
  });

  it('validation — rejects expired to any transition', () => {
    const proposal = makeProposal({ status: 'expired' });
    expect(isTerminalStatus('expired')).toBe(true);
    expect(canTransition('expired', 'draft')).toBe(false);
    expect(canTransition('expired', 'ready_for_review')).toBe(false);
    expect(() => transitionProposal(proposal, 'draft', 'user-1')).toThrow(ConflictError);
  });

  it('validation — rejects executed to any transition', () => {
    const proposal = makeProposal({ status: 'executed' });
    expect(isTerminalStatus('executed')).toBe(true);
    expect(canTransition('executed', 'draft')).toBe(false);
    expect(canTransition('executed', 'approved')).toBe(false);
    expect(() => transitionProposal(proposal, 'draft', 'user-1')).toThrow(ConflictError);
  });

  it('invalid transition — throws ConflictError', () => {
    const proposal = makeProposal({ status: 'draft' });
    try {
      transitionProposal(proposal, 'executed', 'user-1');
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toContain("Cannot transition proposal from 'draft' to 'executed'");
    }
  });
});
