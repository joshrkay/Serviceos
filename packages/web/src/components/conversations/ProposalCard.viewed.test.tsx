import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

import { track } from '../../lib/analytics';
import { ProposalCard } from './ProposalCard';
import type { Proposal } from '../../types/conversation';

const trackMock = vi.mocked(track);

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    type: 'issue_invoice',
    summary: 'Invoice Jane Homeowner $2,500 for the master bath',
    status: 'pending',
    details: {},
    createdAt: '2026-07-16T00:00:00Z',
    ...over,
  };
}

describe('ProposalCard — proposal_viewed', () => {
  beforeEach(() => trackMock.mockClear());

  it('fires proposal_viewed once with type + status (IDs/enums, no summary)', () => {
    render(<ProposalCard proposal={proposal()} userRole="owner" />);

    const calls = trackMock.mock.calls.filter((c) => c[0] === 'proposal_viewed');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ proposal_type: 'issue_invoice', status: 'pending' });
    // never the free-text summary / customer name
    expect(JSON.stringify(calls[0][1])).not.toContain('Jane Homeowner');
  });

  it('does not re-fire on re-render with the same proposal id', () => {
    const { rerender } = render(<ProposalCard proposal={proposal()} userRole="owner" />);
    rerender(<ProposalCard proposal={proposal({ status: 'approved' })} userRole="owner" />);

    expect(trackMock.mock.calls.filter((c) => c[0] === 'proposal_viewed')).toHaveLength(1);
  });

  it('fires again when a different proposal id is shown', () => {
    const { rerender } = render(<ProposalCard proposal={proposal({ id: 'p1' })} userRole="owner" />);
    rerender(<ProposalCard proposal={proposal({ id: 'p2' })} userRole="owner" />);

    expect(trackMock.mock.calls.filter((c) => c[0] === 'proposal_viewed')).toHaveLength(2);
  });
});
