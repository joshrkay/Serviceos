import { describe, it, expect } from 'vitest';
import { createProposal } from '../../src/proposals/proposal';
import {
  resolveProposalIdempotencyKey,
  withResolvedIdempotencyKey,
} from '../../src/proposals/execution/idempotency';

describe('resolveProposalIdempotencyKey', () => {
  it('uses explicit idempotencyKey when present', () => {
    const proposal = createProposal({
      tenantId: 't1',
      proposalType: 'create_customer',
      payload: {},
      summary: 'x',
      createdBy: 'u1',
      idempotencyKey: 'voice:session-1',
    });
    expect(resolveProposalIdempotencyKey(proposal)).toBe('voice:session-1');
  });

  it('defaults to proposal-run scoped key when absent', () => {
    const proposal = createProposal({
      tenantId: 't1',
      proposalType: 'create_customer',
      payload: {},
      summary: 'x',
      createdBy: 'u1',
    });
    expect(resolveProposalIdempotencyKey(proposal)).toBe(
      `proposal-run:t1:${proposal.id}`,
    );
  });

  it('withResolvedIdempotencyKey is a no-op when key already set', () => {
    const proposal = createProposal({
      tenantId: 't1',
      proposalType: 'create_customer',
      payload: {},
      summary: 'x',
      createdBy: 'u1',
      idempotencyKey: 'k',
    });
    expect(withResolvedIdempotencyKey(proposal)).toBe(proposal);
  });
});
