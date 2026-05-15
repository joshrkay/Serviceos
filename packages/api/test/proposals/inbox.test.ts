import { describe, it, expect } from 'vitest';
import { buildInboxPayload } from '../../src/proposals/inbox';
import type { Proposal } from '../../src/proposals/proposal';

function makeProposal(over: Partial<Proposal>): Proposal {
  const now = new Date();
  return {
    id: `prop-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: 't1',
    proposalType: 'draft_invoice',
    status: 'ready_for_review',
    payload: {},
    summary: 'A proposal',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const SOON = new Date(Date.now() + 30 * 60 * 1000);
const FAR = new Date(Date.now() + 24 * 60 * 60 * 1000);

describe('buildInboxPayload', () => {
  it('returns proposals sorted by urgency tier (critical first)', () => {
    const inbox = buildInboxPayload(
      [
        makeProposal({ id: 'normal-1' }),
        makeProposal({ id: 'critical-1', expiresAt: SOON }),
        makeProposal({ id: 'low-1', confidenceScore: 0.99, proposalType: 'add_note' }),
      ],
      100,
    );
    expect(inbox.data[0].proposal.id).toBe('critical-1');
    expect(inbox.data[0].urgency).toBe('critical');
  });

  it('annotates each row with urgency and reason from prioritizeProposals', () => {
    const inbox = buildInboxPayload(
      [makeProposal({ id: 'p1', expiresAt: SOON })],
      100,
    );
    expect(inbox.data).toHaveLength(1);
    expect(inbox.data[0].urgency).toBe('critical');
    expect(inbox.data[0].reason).toMatch(/expir/i);
  });

  it('reports per-tier counts in the summary', () => {
    const inbox = buildInboxPayload(
      [
        makeProposal({ id: 'a', expiresAt: SOON }),
        makeProposal({ id: 'b', expiresAt: SOON }),
        makeProposal({ id: 'c', expiresAt: FAR }),
      ],
      100,
    );
    expect(inbox.summary.criticalCount).toBe(2);
    expect(inbox.summary.normalCount).toBe(1);
    expect(inbox.summary.totalCount).toBe(3);
  });

  it('caps the response at the given limit and reports truncation', () => {
    const proposals = Array.from({ length: 150 }, (_, i) => makeProposal({ id: `p${i}` }));
    const inbox = buildInboxPayload(proposals, 100);
    expect(inbox.data).toHaveLength(100);
    expect(inbox.summary.totalCount).toBe(150);
    expect(inbox.summary.truncated).toBe(true);
  });

  it('returns an empty payload with zero counts for an empty input', () => {
    const inbox = buildInboxPayload([], 100);
    expect(inbox.data).toEqual([]);
    expect(inbox.summary.totalCount).toBe(0);
    expect(inbox.summary.truncated).toBe(false);
  });
});
